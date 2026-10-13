import * as crypto from 'crypto'
import * as http from 'http'
import { REALMS, REALM_IDS, parseModelId } from './realms.js'
import { chatHeaders, threeSegmentUA } from './headers.js'
import { getFreshAccount, recoverAfter401 } from './auth.js'
import { buildBody, sseEventStream, transportCodeFor } from './upstream.js'

// OpenAI 兼容本地网关：/v1/models 与 /v1/chat/completions。
// 只监听回环；Bearer 密钥防本机其他进程白嫖。数据只发往 WorkBuddy 官方端点。

const CATALOG_TTL_MS = 3600_000
const catalogCache = new Map() // realmId -> { at, ids }

async function catalogIds(realm, fetcher) {
  const hit = catalogCache.get(realm.id)
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.ids
  const res = await fetcher(`${realm.chatBase}/v3/config`, {
    headers: {
      accept: 'application/json',
      'user-agent': threeSegmentUA(realm),
      'x-codebuddy-request': '1',
      origin: realm.origin,
      referer: realm.origin + '/',
    },
  })
  const env = await res.json().catch(() => null)
  if (!res.ok || env?.code !== 0 || !env?.data?.models) throw new Error(`catalog HTTP ${res.status}`)
  const d = env.data
  const whitelist = Array.isArray(d.agents) ? d.agents.find((a) => Array.isArray(a?.models))?.models : null
  let ids = Array.isArray(d.models) ? d.models.map((m) => m.id).filter(Boolean) : Object.keys(d.models)
  if (Array.isArray(whitelist) && whitelist.length) ids = ids.filter((id) => whitelist.includes(id))
  catalogCache.set(realm.id, { at: Date.now(), ids })
  return ids
}

function sendJson(res, status, obj, extraHeaders) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...extraHeaders })
  res.end(buf)
}

function sseWrite(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
}

function keyMatches(header, key) {
  const given = String(header ?? '').replace(/^Bearer /, '')
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function createGateway({ port = 8791, host = '127.0.0.1', key, fetcher = globalThis.fetch, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    try {
      if (!keyMatches(req.headers.authorization, key)) {
        return sendJson(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } })
      }
      if (req.method === 'GET' && url === '/health') {
        return sendJson(res, 200, { ok: true, realms: REALM_IDS })
      }
      if (req.method === 'GET' && url === '/v1/models') {
        const data = []
        for (const realmId of REALM_IDS) {
          const realm = REALMS[realmId]
          try {
            for (const id of await catalogIds(realm, fetcher)) data.push({ id: `${realmId}/${id}`, object: 'model', owned_by: 'workbuddy' })
          } catch (e) {
            log(`catalog ${realmId} failed: ${e?.message ?? e}`) // 单站点失败不拖垮另一个
          }
        }
        return sendJson(res, 200, { object: 'list', data })
      }
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        return await handleChat(req, res, { fetcher, log })
      }
      return sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } })
    } catch (e) {
      log(`gateway error: ${e?.stack ?? e}`)
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(e?.message ?? e), type: 'gateway_error' } })
    }
  })

  async function handleChat(req, res, { fetcher, log }) {
    const body = await new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (c) => { raw += c; if (raw.length > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy() } })
      req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { reject(new Error('invalid JSON body')) } })
      req.on('error', reject)
    })
    const { realmId, model } = parseModelId(body.model)
    const realm = REALMS[realmId]
    let account = await getFreshAccount(realmId, fetcher)
    if (!account) {
      return sendJson(res, 401, { error: { message: `${realm.label} 未登录：运行 node server.mjs login ${realmId} 扫码后重试`, type: 'authentication_error' } })
    }
    const payload = buildBody(model, body)
    const post = () => fetcher(`${realm.chatBase}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(account, realm),
      body: JSON.stringify(payload),
    })
    let upstream = await post()
    if (upstream.status === 401) {
      try {
        account = await recoverAfter401(realmId, account, fetcher)
      } catch (e) {
        return sendJson(res, 401, { error: { message: String(e?.message ?? e), type: 'authentication_error' } })
      }
      upstream = await post()
    }
    if (!upstream.ok) {
      const retryAfter = upstream.headers.get('retry-after') ?? (upstream.status === 429 ? '45' : undefined)
      const text = await upstream.text().catch(() => '')
      const code = /"code"\s*:\s*(\d+)/.exec(text)?.[1] ?? ''
      log(`upstream ${upstream.status}${code ? ` code ${code}` : ''} on ${realmId}/${model}`)
      const headers = retryAfter ? { 'retry-after': retryAfter } : undefined
      return sendJson(res, upstream.status, { error: { message: `upstream HTTP ${upstream.status}${code ? ` (code ${code})` : ''}`, type: transportCodeFor(upstream.status).toLowerCase() + '_error' } }, headers)
    }
    const contentType = upstream.headers.get('content-type') ?? ''
    if (!contentType.includes('event-stream')) {
      // 上游偶发返回整体 JSON（非 SSE）：按单帧解析后走同一条输出路径。
      const text = await upstream.text().catch(() => '')
      let obj = null
      try { obj = JSON.parse(text) } catch { /* fallthrough */ }
      const fake = { status: upstream.status, headers: new Headers(), body: (async function* () { if (obj) yield Buffer.from(`data: ${JSON.stringify(obj)}\n\n`) })() }
      return await emitResponse(res, body, sseEventStream(fake.body), log)
    }
    return await emitResponse(res, body, sseEventStream(upstream.body), log)
  }

  return { server, start: () => new Promise((r) => server.listen(port, host, r)), close: () => new Promise((r) => server.close(r)) }
}

/** 把归一化上游事件流翻译成 OpenAI 协议（流式或聚合）。
 * 状态无条件累积（两种模式共用），SSE 写出仅在流式时进行。 */
async function emitResponse(res, body, events, log) {
  const wantsStream = body.stream !== false
  const model = String(body.model ?? '')
  const id = 'chatcmpl-' + crypto.randomUUID()
  const created = Math.floor(Date.now() / 1000)
  const base = { id, object: 'chat.completion.chunk', created, model }
  let usage = null
  let finish = null // { reason, error? }
  let text = ''
  let reasoning = ''
  const tools = new Map() // index → {id, name, arguments}
  const applyEvent = (ev) => {
    if (ev.type === 'usage') { usage = ev.usage; return null }
    if (ev.type === 'finish') {
      finish = { reason: ev.reason === 'tool-calls' ? 'tool_calls' : ev.reason, error: ev.reason === 'error' ? ev.message : null }
      return null
    }
    if (ev.type === 'text') { text += ev.text; return { content: ev.text } }
    if (ev.type === 'reasoning') { reasoning += ev.text; return { reasoning_content: ev.text } }
    if (ev.type === 'toolcall') {
      const buf = tools.get(ev.index) ?? { id: '', name: '', arguments: '' }
      if (ev.id) buf.id = ev.id
      if (ev.name) buf.name = ev.name
      buf.arguments += ev.argumentsDelta ?? ''
      tools.set(ev.index, buf)
      return { tool_calls: [{ index: ev.index, ...(ev.id ? { id: ev.id } : {}), ...(ev.name ? { function: { name: ev.name } } : {}), arguments: ev.argumentsDelta ?? '' }] }
    }
    return null
  }
  const finishReasonOf = () => tools.size ? 'tool_calls' : finish?.reason === 'length' ? 'length' : 'stop'
  try {
    if (wantsStream) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
    for await (const ev of events) {
      const delta = applyEvent(ev)
      if (delta && wantsStream) sseWrite(res, { ...base, choices: [{ index: 0, delta, finish_reason: null }] })
    }
  } catch (e) {
    log(`upstream stream failed: ${e?.message ?? e}`)
    if (wantsStream) {
      // 错误以正文形式入带，agent 循环能看见失败原因而不是收到静默截断。
      sseWrite(res, { ...base, choices: [{ index: 0, delta: { content: `\n[上游错误：${e?.message ?? e}]` }, finish_reason: null }] })
      sseWrite(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      res.write('data: [DONE]\n\n')
      return res.end()
    }
    return sendJson(res, 502, { error: { message: `upstream stream failed: ${e?.message ?? e}`, type: 'gateway_error' } })
  }
  if (!wantsStream) {
    const buffers = [...tools.values()]
    return sendJson(res, finish?.error ? 502 : 200, {
      id, object: 'chat.completion', created, model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          ...(text || !buffers.length ? { content: text + (finish?.error ? `\n[上游错误：${finish.error}]` : '') } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(buffers.length ? { tool_calls: buffers.map((b, i) => ({ id: b.id || `call_${i}`, type: 'function', function: { name: b.name, arguments: b.arguments } })) } : {}),
        },
        finish_reason: finishReasonOf(),
      }],
      ...(usage ? { usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens, prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens } } : {}),
    })
  }
  sseWrite(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReasonOf() }], ...(usage ? { usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}) })
  res.write('data: [DONE]\n\n')
  res.end()
  if (finish?.error) log(`turn ended with upstream error: ${finish.error}`)
}

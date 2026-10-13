import * as crypto from 'crypto'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { DATA_DIR } from './auth.js'
import { REALMS, REALM_IDS, parseModelId } from './realms.js'
import { chatHeaders, catalogHeaders } from './headers.js'
import { getFreshAccount, recoverAfter401, isLoggedIn } from './auth.js'
import { buildBody, sseEventStream, transportCodeFor } from './upstream.js'

// OpenAI 兼容本地网关：/v1/models 与 /v1/chat/completions。
// 只监听回环；Bearer 密钥防本机其他进程白嫖。数据只发往 WorkBuddy 官方端点。

const CATALOG_TTL_MS = 3600_000
const catalogCache = new Map() // realmId -> { at, ids }

async function catalogIds(realm, fetcher) {
  const hit = catalogCache.get(realm.id)
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.ids
  const account = await getFreshAccount(realm.id, fetcher)
  if (!account) throw new Error('not logged in')
  // /v3/config 是 UA 门控 + 鉴权双重：不带令牌会拿到 200 的空配置。
  try {
    const res = await fetcher(`${realm.chatBase}/v3/config`, {
      headers: catalogHeaders(account, realm),
    })
    const env = await res.json().catch(() => null)
    if (!res.ok || env?.code !== 0 || !env?.data?.models) throw new Error(`catalog HTTP ${res.status}`)
    const d = env.data
    const agent = Array.isArray(d.agents) ? d.agents.find((a) => (a?.tags ?? []).includes('default')) : null
    const whitelist = Array.isArray(agent?.models) ? agent.models : null
    let ids = Array.isArray(d.models) ? d.models.map((m) => m.id).filter(Boolean) : Object.keys(d.models ?? {})
    const isRouterTier = (id) => id === 'auto' || id === 'default' || /^default[.-]/.test(id) || /-model$/.test(id) || /(^|-)(completions?|rewrite|nes-|instruct)($|-|.)/.test(id)
    if (Array.isArray(whitelist) && whitelist.length) ids = whitelist.filter((id) => ids.includes(id) && !isRouterTier(id))
    else ids = ids.filter((id) => !isRouterTier(id))
    catalogCache.set(realm.id, { at: Date.now(), ids })
    return ids
  } catch (e) {
    // 目录拉取失败时退回上一次成功的缓存（可能过期但聊胜于无）。
    const stale = catalogCache.get(realm.id)
    if (stale) return stale.ids
    throw e
  }
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

/** 上游 400 时的消毒重试：剔除空消息、剥离控制字符、合并连续 user。
 * 返回 {payload, changed, note}——note 记录做了什么（只含统计，不含正文）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
function sanitizePayload(payload) {
  const notes = []
  let dropped = 0
  let stripped = 0
  let merged = 0
  const cleanString = (t) => {
    const out = t.replace(CONTROL_CHARS, '')
    if (out.length !== t.length) stripped++
    return out
  }
  const rows = (payload.messages ?? [])
    .map((m) => {
      const row = { ...m }
      if (typeof row.content === 'string') row.content = cleanString(row.content)
      return row
    })
    .filter((m) => {
      const isTool = m.role === 'tool' || Array.isArray(m.tool_calls)
      const empty = typeof m.content === 'string' && m.content.trim() === '' && !isTool
      if (empty) dropped++
      return !empty
    })
  const mergedRows = []
  for (const m of rows) {
    const prev = mergedRows.at(-1)
    if (m.role === 'user' && prev?.role === 'user' && typeof m.content === 'string' && typeof prev.content === 'string') {
      prev.content += '\n\n' + m.content
      merged++
      continue
    }
    mergedRows.push(m)
  }
  if (dropped) notes.push(`${dropped} 条空消息`)
  if (stripped) notes.push(`${stripped} 处控制字符`)
  if (merged) notes.push(`${merged} 次连续 user 合并`)
  return { payload: { ...payload, messages: mergedRows }, changed: Boolean(dropped || stripped || merged), note: notes.join('、') || '无变化' }
}

/** 当前可调用的模型：只列已登录站点，目录失败时退回缓存。 */
export async function availableModels(fetcher) {
  const out = []
  for (const realmId of REALM_IDS) {
    const realm = REALMS[realmId]
    if (!(await isLoggedIn(realmId))) continue
    try {
      out.push({ realmId, label: realm.label, ids: await catalogIds(realm, fetcher) })
    } catch (e) {
      out.push({ realmId, label: realm.label, error: String(e?.message ?? e) })
    }
  }
  return out
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
        for (const entry of await availableModels(fetcher)) {
          if (entry.error) log(`catalog ${entry.realmId} failed: ${entry.error}`) // 单站点失败不拖垮另一个
          else for (const id of entry.ids) data.push({ id: `${entry.realmId}/${id}`, object: 'model', owned_by: 'workbuddy' })
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
    // 未知模型在网关层拦截：上游只会报一句 400 (11102)，这里给出可用清单。
    let known = null
    try { known = await catalogIds(realm, fetcher) } catch { /* 目录不可达时不拦，让上游给答案 */ }
    if (known && !known.includes(model)) {
      return sendJson(res, 400, {
        error: {
          message: `模型 ${realmId}/${model} 不存在。可用：${known.slice(0, 20).map((id) => `${realmId}/${id}`).join('、')}（注意拼写，例如 glm 不是 gkm）`,
          type: 'invalid_request_error',
        },
      })
    }
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
      // 形状诊断与变体二分：只记角色/长度/类型，绝不记正文。
      if (upstream.status === 400) {
        const lens = (payload.messages ?? []).map((m) => `${m.role}:${typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? null).length}`).join(' → ')
        log(`upstream 400 (code ${code}); lens ${lens}`)
        const attempt = async (p, tag) => {
          log(`400 二分：尝试变体「${tag}」`)
          try {
            const r = await fetcher(`${realm.chatBase}/v2/chat/completions`, { method: 'POST', headers: chatHeaders(account, realm), body: JSON.stringify(p) })
            if (r.ok) { log(`400 二分：变体「${tag}」成功 —— 根因锁定`); await emitResponse(res, body, sseEventStream(r.body), log); return true }
            log(`400 二分：变体「${tag}」仍 HTTP ${r.status}`)
          } catch (e) { log(`400 二分：变体「${tag}」异常 ${e?.message ?? e}`) }
          return false
        }
        const sanitized = sanitizePayload(payload)
        if (sanitized.changed && await attempt(sanitized.payload, '消毒（' + sanitized.note + '）')) return
        if (Array.isArray(payload.tools) && payload.tools.length && await attempt({ ...payload, tools: undefined }, '去掉 tools')) return
        const clamped = { ...payload, messages: payload.messages.map((m) => (typeof m.content === 'string' && m.content.length > 1200 ? { ...m, content: m.content.slice(0, 1200) + '…[已截断]' } : m)) }
        if (await attempt(clamped, '截断长内容')) return
        const noParams = { ...payload }
        delete noParams.max_tokens
        delete noParams.temperature
        if (await attempt(noParams, '去掉采样参数')) return
        if (payload.messages.length > 2 && await attempt({ ...payload, messages: [payload.messages[0], payload.messages.at(-1)] }, '只留 system+最后一条')) return
        if (process.env.WBZB_DEBUG_DUMP === '1') {
          const dump = path.join(DATA_DIR, `debug-400-${Date.now()}.json`)
          fs.mkdirSync(DATA_DIR, { recursive: true })
          fs.writeFileSync(dump, JSON.stringify(payload, null, 2), { mode: 0o600 })
          log(`全部变体失败；请求体已转储到 ${dump}（含对话内容，用完即删）`)
        }
      }
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

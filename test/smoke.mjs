// Smoke：mock 上游下验证 /v1/models、流式对话、工具往返、非流式、429 透传。
// Run: node test/smoke.mjs
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbz-'))
process.env.WBZB_DIR = tmp

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) { failures++; console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`) }
  else console.log(`ok   ${name} = ${a.length > 100 ? a.slice(0, 97) + '…' : a}`)
}

// ------------------------------- mock 上游 -------------------------------
const upstreamSeen = []
const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = req.url
    const auth = req.headers.authorization ?? ''
    if (url.includes('/v2/plugin/auth/token/refresh')) {
      if (auth === 'stale') { res.writeHead(401).end('{}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { accessToken: 'fresh-token', refreshToken: 'r2', expiresIn: 3600 } }))
      return
    }
    if (url.includes('/v3/config')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { models: [{ id: 'glm-5.3' }, { id: 'deepseek-v4.1-flash' }, { id: 'limited' }], agents: [{ tags: ['default'], models: ['glm-5.3', 'deepseek-v4.1-flash', 'limited'] }] } }))
      return
    }
    const parsed = JSON.parse(body || '{}')
    upstreamSeen.push(parsed)
    if (parsed.model === 'limited') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
      res.end(JSON.stringify({ code: 6004, msg: 'rate limited' }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const frames = [
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'hello' } }] },
      parsed.tools ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: parsed.tools[0].function.name, arguments: '{"x":1}' } }] } }] } : null,
      { choices: [{ delta: {}, finish_reason: parsed.tools ? 'tool_calls' : 'stop' }] },
      { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80, credit: 0.1 } },
    ].filter(Boolean)
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
process.env.WBZB_TEST_BASE_CN = `http://127.0.0.1:${upstream.address().port}`
process.env.WBZB_TEST_BASE_GLOBAL = `http://127.0.0.1:${upstream.address().port}`

// 预置一个已登录账号（直接写网关的令牌文件，模拟已扫码）
const { DATA_DIR } = await import('../lib/auth.js')
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.writeFileSync(path.join(DATA_DIR, 'account-cn.json'), JSON.stringify({ uid: 'u1', accessToken: 'tok-stale', refreshToken: 'stale', expiresAt: 0, realm: 'cn' }))

// ------------------------------- 启动网关 -------------------------------
const { createGateway } = await import('../lib/gateway.js')
const KEY = 'test-key-0123456789abcdefghij'
const gateway = createGateway({ port: 0, key: KEY, fetcher: globalThis.fetch, log: () => {} })
await gateway.start()
// port 0 实际端口要从 server 上取
const PORT = gateway.server.address().port
const BASE = `http://127.0.0.1:${PORT}`
const H = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }

// 鉴权
check('wrong key rejected', (await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer nope' } })).status, 401)

// models（目录拉取 + 站点前缀）
const models = await (await fetch(BASE + '/v1/models', { headers: H })).json()
check('models carry realm prefixes', models.data.map((m) => m.id), ['cn/glm-5.3', 'cn/deepseek-v4.1-flash', 'global/glm-5.3', 'global/deepseek-v4.1-flash'])

// 流式对话 + reasoning + usage
const chat = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'cn/glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true }) })
check('chat stream is SSE', (chat.headers.get('content-type') ?? '').includes('event-stream'), true)
const text = await chat.text()
const frames = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)))
check('stream reasoning then content', frames.some((f) => f.choices?.[0]?.delta?.reasoning_content === 'think'), true)
check('stream content delta', frames.some((f) => f.choices?.[0]?.delta?.content === 'hello'), true)
check('stream ends with finish stop + usage', [frames.at(-1).choices[0].finish_reason, frames.at(-1).usage.prompt_tokens], ['stop', 100])
check('upstream got system-first body', [upstreamSeen.at(-1).messages[0].role, upstreamSeen.at(-1).stream], ['system', true])

// 工具往返（agent 模式）
const tool = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'cn/glm-5.3', stream: true, tools: [{ type: 'function', function: { name: 'run_cmd', parameters: { type: 'object', properties: {} } } }], messages: [{ role: 'user', content: 'run' }] }) })
const toolFrames = (await tool.text()).split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)))
const toolDelta = toolFrames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? [])
check('tool_calls streamed with arguments delta', [toolDelta.some((t) => t.function?.name === 'run_cmd'), toolDelta.map((t) => t.arguments ?? '').join('')], [true, '{"x":1}'])
check('stream finish_reason tool_calls', toolFrames.at(-1).choices[0].finish_reason, 'tool_calls')

// 非流式聚合
const nonStream = await (await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'cn/glm-5.3', stream: false, messages: [{ role: 'user', content: 'hi' }] }) })).json()
check('non-stream aggregates content', [nonStream.object, nonStream.choices[0].message.content, nonStream.choices[0].finish_reason], ['chat.completion', 'hello', 'stop'])

// 未登录站点 401 + 引导文案
const noLogin = await (await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'global/glm-5.3', messages: [{ role: 'user', content: 'x' }] }) })).json()
check('unlogged realm guides to login command', /login global/.test(noLogin.error?.message ?? ''), true)

// 429 透传 + Retry-After
const limited = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'cn/limited', messages: [{ role: 'user', content: 'x' }] }) })
check('429 passes through with retry-after', [limited.status, limited.headers.get('retry-after')], [429, '30'])

// 未知模型在网关层拦截并列出可用项（防 gkm/glm 式笔误打到上游）
const unknown = await (await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'cn/gkm-5.3', messages: [{ role: 'user', content: 'x' }] }) })).json()
check('unknown model rejected locally with available list', [unknown.error?.type, /cn\/glm-5\.3/.test(unknown.error?.message ?? '')], ['invalid_request_error', true])

await gateway.close()
await new Promise((r) => upstream.close(r))
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

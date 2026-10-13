// WorkBuddy 上游请求体与 SSE 解析。移植自 dsh-workbuddy-native（MIT，同作者）。
// 上游的硬性约束：首条消息必须是 system（否则 400 code 11128）、只接受
// 流式（11101）、部分模型拒绝 max_tokens。

export function buildBody(model, body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  // 客户端（ZCode）发来的形状五花八门：content 可能是字符串、分段数组，
  // 角色可能是 OpenAI 新的 developer。上游只认：首条 system + 字符串内容。
  const rows = messages.map(normalizeRow).filter((m) => m !== null)
  const out = []
  let systemDone = false
  for (const m of rows) {
    if (m.role === 'system') {
      if (!systemDone) {
        // 空 system 内容可能同样触发 11128（上游视同缺失），补默认文案。
        const text = typeof m.content === 'string' ? m.content : ''
        out.push(text.trim() ? m : { role: 'system', content: 'You are a helpful assistant.' })
        systemDone = true
      } else out.push({ role: 'user', content: `[system] ${m.content}` })
      continue
    }
    out.push(m)
  }
  if (!systemDone) out.unshift({ role: 'system', content: 'You are a helpful assistant.' })
  const payload = {
    model,
    messages: out,
    stream: true, // 上游拒绝非流式（11101）
    stream_options: { include_usage: true },
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools
      .filter((t) => t?.type === 'function' && t?.function?.name)
      .map((t) => ({ type: 'function', function: { name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters ?? { type: 'object', properties: {} } } }))
  }
  if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) payload.max_tokens = Math.trunc(body.max_tokens)
  if (Number.isFinite(body.temperature)) payload.temperature = body.temperature
  return payload
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).filter(Boolean).join('\n')
  }
  return content == null ? '' : String(content)
}

/** 单条消息形状归一化：developer→system、content 数组→字符串、工具结构保留。 */
function normalizeRow(m) {
  if (!m || typeof m.role !== 'string') return null
  const role = m.role === 'developer' ? 'system' : m.role
  if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    return { role, content: textOf(m.content), tool_calls: m.tool_calls }
  }
  if (role === 'tool') {
    return { role, tool_call_id: m.tool_call_id ?? '', content: textOf(m.content) || '(no output)' }
  }
  // user 消息保留图片段（上游接受 image_url 数组），纯文本一律压成字符串。
  if (role === 'user' && Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url')) {
    const parts = m.content.filter((p) => p && (p.type === 'text' || p.type === 'image_url'))
    if (parts.length) return { role, content: [{ type: 'text', text: textOf(parts.filter((p) => p.type === 'text')) || '(no caption)' }, ...parts.filter((p) => p.type === 'image_url')] }
  }
  return { role, content: textOf(m.content) }
}

export function normalizeUsage(u) {
  if (!u) return null
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    prompt_cache_hit_tokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    prompt_cache_miss_tokens: u.prompt_cache_miss_tokens ?? 0,
    credit: typeof u.credit === 'number' ? u.credit : 0,
  }
}

/** 一帧上游 SSE 数据 → 归一化事件（text/reasoning/toolcall/finish/usage）。 */
export function eventsFromChunk(obj) {
  const out = []
  const choice = obj?.choices?.[0]
  if (obj?.error) {
    const code = String(obj.error?.code ?? 'UPSTREAM_ERROR')
    out.push({ type: 'finish', reason: 'error', code, message: `upstream stream error (code ${code})` })
    return out
  }
  if (choice?.delta) {
    const d = choice.delta
    if (typeof d.reasoning_content === 'string' && d.reasoning_content.length) out.push({ type: 'reasoning', text: d.reasoning_content })
    if (typeof d.content === 'string' && d.content.length) out.push({ type: 'text', text: d.content })
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        out.push({
          type: 'toolcall',
          index: Number.isInteger(t.index) ? t.index : 0,
          id: t.id,
          name: t.function?.name,
          argumentsDelta: typeof t.function?.arguments === 'string' ? t.function.arguments : '',
        })
      }
    }
  }
  if (choice?.finish_reason) out.push({ type: 'finish', reason: choice.finish_reason })
  const usage = normalizeUsage(obj?.usage)
  if (usage) out.push({ type: 'usage', usage })
  return out
}

/** 增量 SSE 读取器（直接给 OpenAI 网关喂转换后的帧）。 */
export async function* sseEventStream(resBody, { signal } = {}) {
  const decoder = new TextDecoder()
  const reader = resBody.getReader()
  let buf = ''
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try { for (const ev of eventsFromChunk(JSON.parse(data))) yield ev } catch { /* 损坏帧跳过 */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* 已释放 */ }
  }
}

/** 上游 HTTP 状态码 → 可重试语义（与宿主词汇一致）。 */
export function transportCodeFor(status) {
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'UPSTREAM_HTTP'
}

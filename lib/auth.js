import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { REALMS } from './realms.js'
import { loginHeaders } from './headers.js'

// 独立令牌存储：网关用自己登录的账号，绝不读 DSH 插件的凭证——refresh token
// 是轮换式的，两个进程共享一个账号会互相把对方的令牌刷失效。
// 登录协议与官方 CLI 相同：auth/state → 扫码 → auth/token → login/account。

export const DATA_DIR = process.env.WBZB_DIR
  ? path.resolve(process.env.WBZB_DIR)
  : path.join(os.homedir(), '.workbuddy-zcode-bridge')

const REFRESH_WINDOW_MS = 10 * 60 * 1000
const ATTEMPT_TTL_MS = 10 * 60 * 1000

const attempts = new Map() // attemptId -> { realmId, state, startedAt }
const inflight = new Map() // `${realmId}:${uid}` -> Promise

function accountFile(realmId) {
  return path.join(DATA_DIR, `account-${realmId}.json`)
}

function readAccount(realmId) {
  try {
    const a = JSON.parse(fs.readFileSync(accountFile(realmId), 'utf8'))
    if (a && typeof a.accessToken === 'string' && a.accessToken) return a
  } catch { /* 未登录 */ }
  return null
}

function writeAccount(realmId, account) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(accountFile(realmId), JSON.stringify(account, null, 2), { mode: 0o600 })
  try { fs.chmodSync(accountFile(realmId), 0o600) } catch { /* win32 空操作 */ }
}

export async function startLogin(realmId, fetcher) {
  const realm = REALMS[realmId]
  if (!realm) throw new Error(`unknown realm: ${realmId}`)
  const res = await fetcher(`${realm.chatBase}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: loginHeaders(realm),
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  })
  const env = await res.json().catch(() => null)
  const state = env?.data?.state
  const authUrl = env?.data?.authUrl
  if (!state || !authUrl) throw new Error(`auth/state failed: HTTP ${res.status}`)
  const attemptId = crypto.randomUUID()
  attempts.set(attemptId, { realmId: realm.id, state, startedAt: Date.now() })
  for (const [id, a] of attempts) if (Date.now() - a.startedAt > ATTEMPT_TTL_MS) attempts.delete(id)
  return { attemptId, authUrl, realm: realm.id }
}

/** @returns {{status:'pending', vendorMsg?} | {status:'ok', nickname?}} */
export async function pollLogin(attemptId, fetcher) {
  const attempt = attempts.get(attemptId)
  if (!attempt) throw new Error('no pending login for this attempt (or it expired); start a new login')
  if (Date.now() - attempt.startedAt > ATTEMPT_TTL_MS) {
    attempts.delete(attemptId)
    throw new Error('login attempt timed out; start a new login')
  }
  const realm = REALMS[attempt.realmId]
  const res = await fetcher(`${realm.chatBase}/v2/plugin/auth/token?state=${attempt.state}`, {
    headers: loginHeaders(realm),
    signal: AbortSignal.timeout(20_000),
  })
  const env = await res.json().catch(() => null)
  const tok = env?.data
  if (!res.ok) throw new Error(`auth/token answered HTTP ${res.status}`)
  if (!env || !tok?.accessToken) {
    // 未扫码与被拒在上游返回里同形，把厂商码透出而不是压成"继续等"。
    return { status: 'pending', realm: realm.id, vendorMsg: env?.msg ? String(env.msg).slice(0, 120) : null }
  }
  const account = {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken ?? '',
    expiresAt: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : 0,
    domain: tok.domain,
  }
  try {
    const ar = await fetcher(`${realm.chatBase}/v2/plugin/login/account?state=${attempt.state}`, {
      headers: { ...loginHeaders(realm), authorization: `Bearer ${account.accessToken}` },
    })
    const aenv = await ar.json().catch(() => null)
    if (aenv?.data?.uid) {
      account.uid = aenv.data.uid
      account.nickname = aenv.data.nickname ?? null
    }
  } catch { /* 账号详情可选 */ }
  writeAccount(realm.id, account)
  attempts.delete(attemptId)
  return { status: 'ok', realm: realm.id, uid: account.uid, nickname: account.nickname }
}

async function refreshForce(realmId, account, fetcher) {
  const realm = REALMS[realmId]
  const key = `${realmId}:${account.uid ?? 'anon'}`
  const existing = inflight.get(key)
  if (existing) return existing
  const run = (async () => {
    const res = await fetcher(`${realm.chatBase}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        ...loginHeaders(realm),
        'user-agent': `${loginHeaders(realm)['user-agent']}`,
        'x-refresh-token': account.refreshToken,
        'x-auth-refresh-source': 'zcode-bridge',
      },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    })
    const env = await res.json().catch(() => null)
    if (!res.ok || !env?.data?.accessToken) {
      throw Object.assign(new Error(`token refresh failed (HTTP ${res.status}) — re-login required`), { needsRelogin: true })
    }
    const patch = { accessToken: env.data.accessToken }
    if (env.data.refreshToken) patch.refreshToken = env.data.refreshToken
    if (env.data.expiresIn) patch.expiresAt = Date.now() + env.data.expiresIn * 1000
    const next = { ...account, ...patch, updatedAt: new Date().toISOString() }
    writeAccount(realmId, next)
    return next
  })().finally(() => inflight.delete(key))
  inflight.set(key, run)
  return run
}

/** 当前账号，临期自动刷新。未登录返回 null（由网关转成 401 + 引导文案）。 */
export async function getFreshAccount(realmId, fetcher, { force = false } = {}) {
  const account = readAccount(realmId)
  if (!account) return null
  if (!force && account.expiresAt && account.expiresAt - Date.now() > REFRESH_WINDOW_MS) return account
  if (!account.refreshToken) return account
  try {
    return await refreshForce(realmId, account, fetcher)
  } catch (e) {
    if (force) throw e
    return account // 预刷新失败不拦路：旧令牌可能仍有效
  }
}

/** 401 后的强制恢复路径。 */
export async function recoverAfter401(realmId, account, fetcher) {
  if (!account?.refreshToken) throw Object.assign(new Error('token rejected and no refresh token stored — re-login required'), { needsRelogin: true })
  return await refreshForce(realmId, account, fetcher)
}

export function isLoggedIn(realmId) {
  return Boolean(readAccount(realmId))
}

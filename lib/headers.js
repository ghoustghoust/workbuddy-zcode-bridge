import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { REALMS } from './realms.js'

// WorkBuddy 上游按 User-Agent 的版本段门控模型目录，所以版本号优先读本机
// WorkBuddy 桌面端的缓存（genieVersion），读不到再用保守回退值。
export const FALLBACK_CLIENT_VERSION = '5.7.6'

let cachedVersion = null

export function clientVersion(realmId) {
  if (cachedVersion) return cachedVersion
  try {
    const cache = path.join(os.homedir(), REALMS[realmId]?.configDir ?? REALMS.cn.configDir, 'cache', 'acc-product-config-v3.json')
    const genie = JSON.parse(fs.readFileSync(cache, 'utf8'))?.genieVersion
    if (typeof genie === 'string' && /^\d+\.\d+\.\d+/.test(genie)) {
      cachedVersion = genie.split('.').slice(0, 3).join('.')
    }
  } catch { /* 桌面端不存在 */ }
  return cachedVersion ?? FALLBACK_CLIENT_VERSION
}

export function threeSegmentUA(realm) {
  return `WorkBuddy/${clientVersion(realm.id)} ${realm.uaPlatform}/CLI`
}

export function loginHeaders(realm) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': threeSegmentUA(realm),
    'x-codebuddy-request': '1',
    origin: realm.origin,
    referer: realm.origin + '/',
    'accept-language': realm.acceptLanguage,
  }
}

export function chatHeaders(account, realm) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-requested-with': 'XMLHttpRequest',
    origin: realm.origin,
    referer: realm.origin + '/',
    'user-agent': threeSegmentUA(realm),
    'x-codebuddy-request': '1',
    'accept-language': realm.acceptLanguage,
    authorization: `Bearer ${account.accessToken}`,
    'x-agent-purpose': 'conversation',
    'x-ide-name': 'WorkBuddy',
    'x-ide-type': 'WorkBuddy',
    'x-ide-version': clientVersion(realm.id),
    'x-product': 'WorkBuddy',
  }
}

// 目录端点按 x-product 区分返回：SaaS 头拿到的是完整实时清单，
// WorkBuddy 头只会拿到 CLI 的旧列表（实测 2026-10-14）。
export function catalogHeaders(account, realm) {
  return {
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    authorization: `Bearer ${account.accessToken}`,
    'x-user-id': account.uid ?? '',
    'x-domain': new URL(realm.chatBase).host,
    'x-product': 'SaaS',
    'user-agent': threeSegmentUA(realm),
    'x-codebuddy-request': '1',
    'accept-language': realm.acceptLanguage,
    'x-ide-version': clientVersion(realm.id),
  }
}

// 站点端点与路由。移植自 dsh-workbuddy-native（MIT，同作者）。
// WBZB_TEST_BASE_<REALM> 把站点指到本地替身，仅供测试，正常使用不生效。

const base = (realmId, fallback) => process.env[`WBZB_TEST_BASE_${realmId.toUpperCase()}`] || fallback

export const REALMS = {
  cn: {
    id: 'cn',
    label: 'WorkBuddy 国内版',
    chatBase: base('cn', 'https://copilot.tencent.com'),
    origin: 'https://www.codebuddy.cn',
    acceptLanguage: 'zh-CN',
    uaPlatform: 'WorkBuddy',
    configDir: '.workbuddy',
  },
  global: {
    id: 'global',
    label: 'WorkBuddy 国际版',
    chatBase: base('global', 'https://www.workbuddy.ai'),
    origin: 'https://www.workbuddy.ai',
    acceptLanguage: 'en-US',
    uaPlatform: 'WorkBuddy AI',
    configDir: '.workbuddy-ai',
  },
}

export const REALM_IDS = Object.keys(REALMS)

/** 网关暴露的模型 id 形如 `cn/glm-5.3`；解析失败默认国内版。 */
export function parseModelId(model) {
  const at = String(model ?? '').indexOf('/')
  if (at > 0) {
    const realm = String(model).slice(0, at)
    if (REALMS[realm]) return { realmId: realm, model: String(model).slice(at + 1) }
  }
  return { realmId: 'cn', model: String(model ?? '') }
}

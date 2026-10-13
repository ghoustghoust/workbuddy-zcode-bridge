#!/usr/bin/env node
// workbuddy-zcode-bridge 入口。
//   node server.mjs            启动 OpenAI 兼容网关（127.0.0.1:8791）
//   node server.mjs login cn   扫码登录（cn | global），令牌存本机独立目录
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { REALM_IDS, REALMS } from './lib/realms.js'
import { DATA_DIR, startLogin, pollLogin, isLoggedIn } from './lib/auth.js'
import { createGateway } from './lib/gateway.js'

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)

function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(DATA_DIR, 'config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 首次运行 */ }
  if (!Number.isInteger(cfg.port) && cfg.port !== undefined) throw new Error('config.json: port 必须是整数')
  if (typeof cfg.key === 'string' && cfg.key.length > 0 && cfg.key.length < 24) throw new Error('config.json: key 至少 24 字符')
  if (!cfg.port) cfg.port = 8791
  if (!cfg.key) {
    cfg.key = crypto.randomBytes(24).toString('base64url')
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    log(`已生成网关 API Key 并写入 ${file}（同时打印在下方）`)
  }
  return cfg
}

async function cmdLogin(realmId) {
  if (!REALM_IDS.includes(realmId)) throw new Error(`站点必须是 ${REALM_IDS.join(' 或 ')}`)
  const fetcher = globalThis.fetch
  const { attemptId, authUrl } = await startLogin(realmId, fetcher)
  log(`${REALMS[realmId].label} 登录：请在浏览器打开以下链接扫码（10 分钟内有效）`)
  console.log(authUrl)
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000))
    let result
    try { result = await pollLogin(attemptId, fetcher) } catch (e) { log(`登录失败：${e?.message ?? e}`); process.exit(1) }
    if (result.status === 'ok') { log(`登录成功：${result.nickname ?? result.uid}`); return }
    if (result.vendorMsg) log(`等待扫码…（${result.vendorMsg}）`)
  }
}

async function cmdStatus() {
  const cfg = loadConfig()
  console.log(`配置目录：${DATA_DIR}（密钥与令牌长期保存，重启/重开机均有效）`)
  console.log(`API Key：${cfg.key}`)
  for (const id of REALM_IDS) {
    let line = `${REALMS[id].label}：未登录（node server.mjs login ${id}）`
    try {
      const accFile = path.join(DATA_DIR, `account-${id}.json`)
      const acc = JSON.parse(fs.readFileSync(accFile, 'utf8'))
      const expiry = acc.expiresAt ? new Date(acc.expiresAt).toLocaleString('zh-CN') : '长期'
      line = `${REALMS[id].label}：已登录（${acc.nickname ?? acc.uid}，令牌到期 ${expiry}）`
    } catch { /* 未登录 */ }
    console.log(line)
  }
}

async function cmdServe() {
  const cfg = loadConfig()
  for (const id of REALM_IDS) log(`${REALMS[id].label}: ${isLoggedIn(id) ? '已登录' : '未登录（node server.mjs login ' + id + '）'}`)
  const gateway = createGateway({ port: cfg.port, key: cfg.key, log })
  await gateway.start()
  log(`OpenAI 兼容网关已启动：http://127.0.0.1:${cfg.port}/v1`)
  log(`API Key：${cfg.key}   ← 填入 ZCode 的自定义供应商`)
  log('模型名带站点前缀，例如 cn/glm-5.3 或 global/deepseek-v4.1-flash')
}

const [, , cmd, arg] = process.argv
if (cmd === 'login') await cmdLogin(arg ?? 'cn')
else if (cmd === 'status') await cmdStatus()
else await cmdServe()

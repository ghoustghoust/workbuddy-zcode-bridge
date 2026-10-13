# workbuddy-zcode-bridge

把 **WorkBuddy**（国内版 / 国际版）的模型以 **OpenAI 兼容协议**暴露给本机的 [ZCode](https://zcode-ai.com)（或其他 OpenAI 协议客户端）调用。一个独立进程，不依赖 DeepSeek Harness。

> **免责声明**：本项目与 WorkBuddy、CodeBuddy、腾讯或 DeepSeek 均无隶属关系，也未获得任何授权。插件通过逆向 WorkBuddy 客户端的私有 API 实现，**随时可能因上游改动而失效**。使用本插件可能违反 WorkBuddy 的服务条款，相关风险由使用者自行承担。模型输出与计费条款归属于 WorkBuddy 平台及各模型厂商，与本桥无关。按「现状」提供，不附带任何担保（详见 [LICENSE](./LICENSE)）。

## 数据流向（隐私声明）

**无遥测、无统计上报、无第三方数据接收方。** 网络通信只有以下方向：

| 数据 | 发送到 | 何时 |
|---|---|---|
| 对话消息（OpenAI messages 原样转换） | WorkBuddy 官方 API：国内版 `copilot.tencent.com`，国际版 `www.workbuddy.ai` | 每次 chat 请求 |
| 模型目录请求（`/v3/config`） | 同上 | `/v1/models` 查询（1 小时缓存） |
| 账号令牌 | 同上（鉴权头 / 刷新端点） | 随请求 |
| 设备码登录 | 官方授权页 | 仅当运行 `login` 命令 |

**只留在本机**：令牌（`~/.workbuddy-zcode-bridge/account-*.json`，0600）、网关配置与 API Key（同目录 `config.json`）。不记录对话内容，不落任何请求/响应体。

**独立性**：网关使用自己扫码登录的账号，令牌独立存储与刷新——refresh token 是轮换式的，与 DeepSeek Harness 插件共享账号会导致两边互相踢下线，因此本项目**不读、不写**其他工具的凭证。

## 快速开始

```bash
node server.mjs login cn        # 扫码登录国内版（global 同理）
node server.mjs                 # 启动网关，默认 127.0.0.1:8791
```

启动时会打印自动生成的 API Key。然后在 ZCode 的模型供应商列表底部**添加供应商**（不要改内置条目）：

| 字段 | 值 |
|---|---|
| OpenAI 接口地址 | `http://127.0.0.1:8791/v1`（必须带 `/v1`） |
| API Key | 启动时打印的密钥 |
| 模型名 | 带站点前缀，如 `cn/glm-5.3`、`global/deepseek-v4.1-flash` |

支持流式与非流式、`tools` 工具调用（agent 模式）、`reasoning_content` 思考过程。上游 429 限流会原样透传给 ZCode（带 `Retry-After`），由客户端退避。

## 测试

```bash
node test/smoke.mjs   # mock 上游：models / 流式 / 工具往返 / 非流式 / 429
```

## 已知边界

- 上游私有 API 逆向而来，改版即失效
- 需要对话的 realm 先扫码登录；未登录的请求返回 401 并提示登录命令
- 网关只监听 `127.0.0.1`，Bearer 密钥防本机其他进程调用；令牌按 0600 权限存储

## License

[MIT](./LICENSE)。WorkBuddy、CodeBuddy 为各自所有者的商标/产品，本项目与其无任何隶属关系。

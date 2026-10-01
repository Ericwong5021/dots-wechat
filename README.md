# dots-wechat

中文：把你本人发给微信 bot 的文字接入**已有的 personal dot**，并把受限回复送回同一私聊的独立研究原型。默认只启动本机禁用模式的 MCP 服务；真实 dot 自动回复仍待验收。

English: An independent research prototype for forwarding your own Weixin bot messages to an existing personal dot and returning a restricted reply to the same private conversation. The default MCP service runs locally with messaging disabled. The automatic dot round trip has not been accepted yet.

> **验收状态：已有 personal dot 自动闭环未验收。408 项本地测试通过，网络仅为合成响应与 loopback。微信固定回复或手动收发不能证明 dot 自动接入。**

项目依据腾讯公开的 [iLink 协议参考](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol.md)编写兼容客户端，固定参考 revision `24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c`。它不是腾讯或 OpenAI 官方产品，也不包含整套 OpenClaw/Hermes。使用者需满足服务条款和自身账号资格；公开协议不能保证账号、地区和服务能力可用，协议变化可能使客户端失效。

## 当前能力

| 能力 | 证据与限制 |
| --- | --- |
| 本人微信纯文本收发 | 原实验已由用户确认同一私聊收到固定测试回复；该证据不是新安装的验收结果 |
| 本机 MCP 健康与目录发现 | 有独立仓库本地回归；默认不读凭据、不轮询、不发事件或回复 |
| 去重、私有状态、受限回复与查询 | 有本地合成测试；API 接受与用户看到回复分别记录 |
| 已有 dot 自动 MCP 闭环 | 未验收，暂无可报告的端到端延迟 |
| 连续语音、群聊、媒体与其他联系人 | 未验证，不在本教程范围内 |

独立仓库已通过本地回归，包含 loopback HTTP 与合成网络响应。测试不能证明生产可用性、真实 dot 自动回复或新安装的用户可见送达；具体结果以所使用版本的测试输出为准。

## 开始

1. 按 [安装](docs/installation.md)完成依赖、本机禁用服务和本人扫码登录。
2. 阅读 [配置与权限数据流](docs/configuration.md)，再进行单条微信文字收发核验。
3. 按 [停止与撤销](docs/revocation.md)结束测试。常见问题见 [故障排查](docs/troubleshooting.md)。

安装路径为 `~/project/dots-wechat`。`npm start` 的行为是前台监听 `127.0.0.1:8890`、MCP `/mcp`、最长 30 分钟，保持真实消息处理禁用。它不会自动把微信连接到 dot。

> 当前为研究原型。绑定与单条收发 CLI 的本地合成测试不代表已有 personal dot 的自动事件闭环已验收。

## 独立目录

```text
package.json
src/
  weixin/   client.mjs, private-state-store.mjs, binding.mjs, cli.mjs
  journal/  journal.mjs
  status/   status.mjs
  mcp/      server.mjs, backend.mjs, cli.mjs
docs/
```

测试与对应实现放在相邻目录。运行时凭据、二维码、聊天正文、游标、上下文、journal 密钥和人工验收材料不进入源码仓库。源码复用和第三方许可需在仓库许可证与来源说明中保留。

## dot 接入的下一阶段

接入依赖 [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)，并需真实主体授权、callback 验证、事件投递、撤销和有期限的订阅。当前版本没有启用公网入口、Secure MCP Tunnel 或 OAuth。这里只列 [前置动作](docs/configuration.md#接入已有-dot-前的动作)，不提供会创建隧道、client、key 或 grant 的命令。

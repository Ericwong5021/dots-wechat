# dots-wechat

让你已有的 dot 帮你安装本机微信网关、在当前私聊发来二维码，你只需授权、本人扫码和发测试文字。目标是持续多轮纯文本经已有 dot 自动回答、回到同一微信私聊。需要 dot 支持**获授权的本人 Mac/Linux 执行**和**私有原生图片附件**；云端 dot 不一定具备这些能力。持续自动回传尚未验收。

English: Ask your existing dot to install the local gateway and send you a private QR image. This requires authorized execution on your Mac/Linux machine and native private image attachments. Ongoing text conversations through the existing dot remain unverified.

> **持续文字自动闭环未验收。589 项本地测试通过，仅合成响应与 loopback；不能证明真实 dot 已接通。**

## 复制这一段给你已有的 dot

```text
请帮我安装 https://github.com/Ericwong5021/dots-wechat 。先读取仓库 README、AGENTS.md 和 docs/onboarding.md，检查你能否在获我授权的本人 Mac/Linux 上执行，以及向当前私聊发送原生私有图片附件；缺少能力就准确说明阻塞，不让我手动敲终端、不读旧微信/OpenClaw/Hermes凭据、不上传二维码到公开地址。先在新的隔离目录完成公共源码安装、测试、CLI帮助与doctor无凭据自检，不登录微信。通过后，向我说明此次新bot、本人扫码、指定本机路径的新凭据存储、owner-only文字私聊范围，以及本次私有二维码附件可能被聊天平台保留；等我明确同意，再用代理登录入口生成并发给我二维码，由我本人扫码确认。随后给我随机标记，做一次有界固定回复核验并让我确认收到。最终目标是持续多轮文字由已有dot自动回答并回到原会话；具体Tunnel/Events/认证方案需新授权，验收须包含多轮随机内容、真实dot事件/工具调用、可见回复、重复与断线/重启防重。固定回复不算自动验收，D尚未完成；语音与双向文件留到D通过后另议。
```

你不需要把安装命令复制到终端。dot 的能力检查、分阶段授权和失败处理见 [首次安装流程](docs/onboarding.md)。二维码与新凭据都是私人登录材料，不提交到仓库或公开 issue。

## 验证到哪一步

| 阶段 | 验证的事实 |
| --- | --- |
| A：安装与自检 | 公共源码、依赖、测试、CLI 与 doctor 无凭据自检通过，默认 MCP 禁用 |
| B：本人扫码 | 本次新 bot 绑定成功，新凭据只保存在获授权的本机位置 |
| C：单条微信核验 | 随机文字入站，同一私聊尝试一次批准的固定回复，本人确认可见 |
| D：持续多轮文字自动回传 | 需另行批准真实 Tunnel/Events/认证，验证真实 dot 回传、重复/断线/重启防重，尚未验收 |

本项目是依据腾讯公开 [iLink 协议参考](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol.md)编写的兼容研究原型，不是腾讯或 OpenAI 官方产品。协议变化、账号/地区资格可能影响可用性；连续语音、媒体、群聊与其他联系人未验证。默认 MCP 禁用真实消息处理，本地测试与微信固定回复都不能证明 D 已完成。

代理登录与明确批准后的本机撤销接口已定义；它的确认 flags 只是非 TTY 技术声明，不能代替你在真实会话中的明确授权。二维码须由具备能力的 dot 私下发送，不能把本机路径写成附件已经送达。持续文字自动回传未验收；语音和双向文件仅记录为 D 通过后的下一阶段，不在此次实现范围内。

## 技术文档与许可

[安装细节](docs/installation.md)、[配置与数据流](docs/configuration.md)、[停止与撤销](docs/revocation.md)、[故障排查](docs/troubleshooting.md)、[本地接口与容量边界](docs/local-contracts.md)供执行安装的 dot 或维护者查阅。用户入口是上面的单段指令。

原创代码使用 [MIT](LICENSE)；46 个依赖与腾讯协议参考的 47 份许可完整保留，见 [第三方说明](THIRD_PARTY_NOTICES.md)、[许可清单](licenses-manifest.json)和 [来源](provenance.json)。默认 MCP 身份为 `dots-wechat-local`，仅监听 loopback，真实 backend 禁用；没有开机自启或自动隧道。

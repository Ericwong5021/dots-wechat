# 有限故障排查

先记录固定错误类别、Node 版本、操作阶段和大致时刻。不要提交二维码、验证数字、token、credentials 内容、聊天正文、context token、游标、原始响应或私人截图。

| 现象/状态 | 核对与下一步 |
| --- | --- |
| `npm ci` 失败 | 确认在 `~/project/dots-wechat` 根目录、Node `>=22.13`、锁文件与 package.json 对应；不要临时改依赖来伪装通过 |
| CLI 文件或参数不存在 | 确认取得的是包含独立 CLI 的审阅版本；不要改用旧私有实验路径或读取旧凭据 |
| 8890 端口被占用 | 本服务应退出；查看自己的前台终端，停止自己的旧实例，保留不明服务 |
| `/healthz` 显示禁用、受保护方法被拒 | 默认预期行为；启动 MCP 不自动登录微信或授权真实 dot 操作 |
| 二维码 `wait` / `scaned` | 仍在等待本人操作/服务确认，未等同成功保存 |
| `expired` / `BINDING_EXPIRED` | 本次二维码过期；退出后重新发起本人登录，不复用旧二维码 |
| `need_verifycode` | 按官方界面完成本人验证；CLI 未支持该步骤时停止，不绕过验证 |
| `redirect_requires_verification` / `UNSUPPORTED_PROVIDER_BASE_URL` | 本原型仅允许审阅过的固定原点；停止并核对官方协议和地区路由，不关闭原点检查 |
| `EXISTING_BINDING_NOT_IMPORTED` | 原型没有导入旧绑定；不要复制旧 token 作为处理办法 |
| `CREDENTIAL_SAVE_FAILED_NO_RETRY` | 可能是路径、权限、已有目录/文件或保存失败；不覆盖旧文件。确认无残留进程后排查专用目录，再由本人新建一次绑定 |
| `SESSION_EXPIRED` | 客户端停止使用当前 token；停止实验，按本人新登录流程处理，不导入其他项目会话 |
| `OK` 但无消息 | 确认扫码本人、当前 bot 私聊、纯文字及精确标记；不要读取历史聊天、群聊或其他联系人来补样本 |
| `EXPECT_NOT_SEEN` / `VERIFY_DEADLINE` | 在有界期限内没有完成指定验证，退出码 2；本人核对实际发送时机，另起一轮新标记测试，不重发旧 UNKNOWN 消息 |
| `AMBIGUOUS_EXPECT` | 同批多条文字完全匹配；本轮拒绝发送，下一轮使用新的唯一标记，不重复发送测试文字 |
| `STORAGE_BLOCKED` / 锁被占用 | 停止第二个写入者，核对本人目录权限、磁盘与时钟；不抢占异常锁或删除去重文件来继续发信 |
| `EXPIRED_CONTEXT` | 原回复窗口已过，不复用旧上下文；只能让本人发一条新的、另行批准的测试文字 |
| `OUTCOME_UNKNOWN` / `ALREADY_ATTEMPTED` | 不重发。本人检查同一私聊是否收到，另记可见确认，不修改原始发送回执 |
| `API_ACCEPTED` 但尚未看到 | API 接受与可见送达分开；保留待确认，不把 HTTP 200 写成送达 |
| 微信固定回复成功，但 dot 无活动 | 当前 dot 自动链路尚未验收。按配置文档核对后续前置动作，不能凭微信收发成功跳过授权或 callback 验证 |

MCP 的 loopback Host/Origin 检查是默认边界。不要通过设置宽泛 CORS、伪造 owner header、绑定公网地址或增加测试身份来处理拒绝。端点需要新的传输/认证设计时，先完成审阅与授权。

协议变化或账号资格可能导致登录/收发不可用。请以腾讯实际服务反馈和[固定版本协议参考](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol.md)为依据；本项目不保证绕过限制，也不保证连续语音或商业服务能力。

## dot 代安装与图片交付

本机执行、可续接登录进程和当前用户私有原生图片附件都必须实际可用；不能由云端容器或本机路径推断。缺能力时具体报告并停止依赖步骤，不让用户改用手动终端。`npm run doctor` 无凭据检查 QR 渲染和禁用 loopback MCP，`--help` 不启动登录。

代理登录需在明确新绑定与存储范围授权后使用完整 agent flags。`AGENT_CONSENT_SCOPE_REQUIRED` 是接口参数缺失，不表示用户已经同意；`QR_READY` 不表示图片已交付或绑定已确认。`BINDING_INTERRUPTED` 是主动中止，`LOCAL_BINDING_DEADLINE` 是本地等待到期，`AGENT_VERIFICATION_CODE_UNSUPPORTED` 表示当前代理接口无法完成额外验证码；这些都不应自动刷新二维码。图片上传失败时停止本轮并报告交付失败。本地清理不删除平台已保存的私有附件。

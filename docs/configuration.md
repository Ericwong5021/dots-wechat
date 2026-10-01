# 配置、权限与数据流

## 默认本机服务

根目录 `npm start` 运行 `node src/mcp/cli.mjs`：IPv4 loopback `127.0.0.1:8890`，MCP 地址 `http://127.0.0.1:8890/mcp`，健康地址 `/healthz`，前台手动运行，默认及最长 30 分钟。没有后台守护、开机自启或自动隧道。MCP identity 为 `dots-wechat-local`，非敏感状态资源为 `dots-wechat://gateway/status`，消息状态模板为 `dots-wechat://message/{request_id}/status`。

默认 backend 禁用真实微信处理。不通过环境变量自动启用，不把客户端传入的 owner、HTTP header 或 `_meta` 当成可信身份。MCP CLI 支持 `--port` 与 `--duration-seconds`；不能添加 `--live` 或 `0.0.0.0` 来绕过限制。

## 本机私有文件

教程使用 `~/project/dots-wechat/.runtime/weixin-local`。登录凭据目录权限为 `0700`，`credentials.json` 权限为 `0600`，只存此次新 bot 身份与 token。`verify` 在同一目录使用 `verify-state.json`（`0600`）与单写入者锁保存私有恢复状态。不要通过 `cat`、截图、报告或 issue 展示这些文件。

客户端私有状态只保存恢复与防重所需的游标、待处理文字和回复上下文；终态删去待处理正文/上下文并保留防重记录。它不保存登录 token。状态文件依赖单写入者锁和原子保存；锁异常时不自动抢占。journal 使用独立加密与关联校验，不能因此推断登录凭据或所有运行时文件都已加密。二维码仅在登录过程中写入私有临时目录，结束时清理，不属于长期配置。

运行时文件必须被 Git 忽略，源码导出和备份共享也应排除它们。删除状态会丢失去重证据，不能用来重试结果未知的发送。

## 谁能读写什么

| 阶段 | 数据与权限 |
| --- | --- |
| 申请二维码 | 向腾讯固定原点发必要登录协议元数据；本人扫码确认此次新 bot |
| 本机微信核验 | 出站 HTTPS 长轮询；只接受扫码本人发给当前 bot 的纯文本私聊 |
| 本机落盘 | 新凭据与最小恢复状态留在 Mac/本机，不上传仓库 |
| 未来 Events 接入 | 仅获准文本与关联 ID送入创建订阅的原有 dot；bot token 与 context token 留在本机 |
| 未来回传工具 | 只沿原入站关联回复同一私聊；模型不能另选联系人或任意 callback URL |

当前客户端固定原点为 `https://ilinkai.weixin.qq.com`。其他来源、群聊和媒体被过滤。当前限制为入站文本最多 4000 UTF-16 单元/16000 UTF-8 字节、回复最多 800 单元/2048 字节，默认回复上下文有效期 10 分钟；这都是本客户端限制，不是腾讯服务承诺。

## 状态应怎样解读

`API_ACCEPTED` 只说明当前发送响应满足客户端的 API 接受规则。`OUTCOME_UNKNOWN` 表示无法安全确定发送结果，不自动重试；进程在发送中中断后的恢复同样保持未知。用户可见送达需要独立确认。`EXPIRED_CONTEXT` 不再回传，不能手工复用旧 context token。

## 接入已有 dot 前的动作

本教程不创建或配置公网 tunnel/OAuth。后续真实接入需先完成以下动作，并分别取得授权：

1. 核验本人 Platform 组织、目标 ChatGPT 工作区、开发者模式资格和实际费用条款。ChatGPT 订阅或看到创建按钮不证明这些条件已满足。
2. 审阅并批准一条具体传输路径及最小权限新凭据。首轮只做最多 30 分钟、无私聊的 discovery/health；不开放其他本机服务。
3. 审阅真实主体授权与本人微信绑定映射。隧道可达性不提供微信 owner 身份。若选择 OAuth，先取得真实 issuer、resource、exact redirect、scope、有效期和撤销方式，再验证认证；不猜值或借用旧 token。
4. 完成 callback challenge、HTTPS/DNS/TLS 验证、签名投递、订阅期限与撤销、重启后的安全处理。当前本地合成接口不能当成生产适配器。
5. 本人在**已有目标 dot**中建立有限期限订阅，核对该 dot 的可见事件及其真实回传工具调用，再在同一微信私聊确认收到回复，记录脱敏关联与分段延迟。

项目候选事件是 `weixin.owner_message`，回传工具是 `weixin.deliver_owner_reply`，状态工具是 `weixin.get_message_status`。它们是项目接口名称，不代表已注册到用户的插件。SSE 目录通知不能代替 Events webhook 订阅。新本地字节/注入投递、身份检查点与有界容量的源码和未实现边界见 [本地接口契约](local-contracts.md)；它们没有启用真实模式。

官方参考：[MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。普通工具的 No Authentication 支持不能证明真实个人事件已有可信身份；具体安全模型仍需审阅。

## 独立状态与原项目

本项目创建独立新状态。journal 使用 `dots-wechat-journal/1` 格式，不能直接打开旧实验 journal。提取源码不迁移原项目的凭据、密钥、游标或聊天；现有绑定与回滚材料留在原处。请勿复制旧状态后清除防重记录来重试消息。

# 私有 Tunnel 与当前聊天的验证路线

这份笔记是架构核对，未创建 Tunnel、插件、密钥、OAuth grant 或订阅，也未启动真实服务。仓库默认 backend 禁用；受控运行模块仍需实际装配。没有要求 OpenAI 提供不存在的 signed personalDotId。

[Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)正式支持 OAuth、No Authentication 和 Mixed Authentication。[私有 Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)通过出站连接转发 MCP，按关联组织/工作区及 Read/Use 权限控制使用上下文，Mac 可只监听 loopback。私有不代表数据仅留在 Mac，也不代表新 Tunnel 默认只有创建者可用。[客户端 v0.0.14 权限说明](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/permissions.md)可用于核查实际权限；不要从一个隐藏 URL 推断访问限制。

单用户、30 分钟 NoAuthentication 试验是**有条件方案**：先核实专用 Tunnel 的有效使用主体和关联上下文仅为本人，插件保持本人私有草稿，没有组织共享、其他可用密钥或额外调用主体；服务只接受本轮受控通道，一个 owner、一个有限订阅、纯文字及关联回传，到期关闭。无法核实这些条件时不启用本人消息处理。静态本地 token 只能约束通道，不能把自报 header、dotId 或 `_meta` 当身份。当前代码没有实现这一部署边界 authorizer，不能通过给现有 verifier 填测试值启用它。

[Events 文档](https://developers.openai.com/plugins/build/mcp-events)要求按用户权限和 authenticated principal 管理订阅；目前未找到明确说明 Tunnel-only NoAuthentication 如何满足这项要求的官方示例，因此该组合仍需实际资格与协议验证，不能宣称已获官方端到端保证。文档明确事件进入发起订阅的聊天：先在用户选定的已有 dot 聊天里订阅，然后让用户在该聊天手动指定本次随机短语，再从本人微信发另一条随机测试文字，核对该聊天的事件处理、同一关联的回传工具和原微信可见回复。随机短语是可见关联证据，不是加密身份认证；同一账号其他聊天的访问隔离也不能由它证明。

若实际界面或 Events 要求 OAuth，最小确定选择是用户已有且可管理的兼容 provider；没有时可评审 Auth0 单用户开发 tenant。工程方负责配置一个 MCP API resource、事件/回复两个最小本应用权限、确切 ChatGPT callback、Authorization Code + PKCE S256、仅本人 allowlist、短期 token 和签名/audience/scope 校验。用户只需批准新 provider 与数据范围、本人创建/登录账户，并在 ChatGPT 完成一次授权；不要求用户自行找 issuer/verifier 参数。不得读取旧凭据或凭空设置主体。OAuth 认证 owner，当前 dot 的可见关联仍走订阅所在聊天。[OpenAI 认证](https://developers.openai.com/plugins/build/auth)、[Auth0 PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce)、[Auth0 token 校验](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)。

Auth0 [价格页](https://auth0.com/pricing)在 2026-10-01 列出 Free $0/月、注册不需信用卡；这不是本项目已开通或所有配置免费承诺。新 tenant/application/API 注册、登录身份交给 provider、可能的客户端 secret 和撤销方式仍需具体批准。使用供应商默认域名，遇付费、额外范围或长期权限即停止；不自行创建公共授权服务。

实际账号资格也要核验：[Help](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)当前对 Pro 写操作的说明与 Developer mode guide 不完全一致，不能提前承诺回传动作可用。先确认目标账号能选择该私有 Tunnel、扫描 Events 并允许回复工具，再运行有界测试。Public GitHub 源码发布不等于插件公开分发，私有 Tunnel 不用于公共插件提交。

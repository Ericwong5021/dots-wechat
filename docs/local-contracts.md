# 本地接口与持续处理边界

这些模块只有本地合成验证。导入它们不启动监听、创建订阅或读取凭据；MCP CLI 仍不提供真实模式。测试中的主体、签名材料和文本全部为合成数据。

## 事件字节与注入投递

`src/mcp/event-wire.mjs` 独立实现本项目事件的 JSON envelope、Standard Webhooks HMAC、请求头及签名时使用的原始字节。挑战响应要求有效期限内的 2xx 与常量时间比较；解码先验证签名再解析正文。签名时间使用 Unix 秒。事件和挑战都保持一次序列化后的同一正文。

`src/mcp/injected-event-delivery.mjs` 必须显式注入 transport，没有默认 fetch、真实 HTTPS 或后台进程。它可装入 `injected-local` backend 的 `verifySubscription` 与 `publishEvent`。挑战使用新随机值和唯一 ID，成功缓存绑定完整主体、callback、签名材料和有限期限。每次调用有界，取消、关闭或过期后的迟到成功不能重新激活；不确定投递不自动重试。2xx 仅证明注入 transport 的回执，不能证明 dot 已处理或微信已送达。

URL 检查只有语法，`redirect: error` 只是要求注入 transport 遵守的元数据。当前模块没有真实连接时的 DNS、公网地址、TLS hostname 和 redirect 防护，不应交给普通 fetch 当作生产安全适配器。签名密钥轮换、持久订阅、真实 SDK/ChatGPT callback 互操作也未验收。[官方 MCP Events](https://developers.openai.com/plugins/build/mcp-events)要求上述真实传输与持久化能力；本地签名测试不会替代它们。

## 受信身份契约

`src/mcp/authorization.mjs` 要求服务端显式注入已绑定验证请求的外部 verifier，并固定预期的七字段 principal：tenant、subject、grant、binding、watch、generation 和 revision。每个检查点重新调用 verifier，校验到期和主体一致性；仅接受本实例生成的授权快照。它拒绝将 `_meta`、headers、JWT claims 或 `verified: true` 声明直接当成身份。

该模块是结构与检查点契约，不是生产身份验证器。OAuth 路径的真实 issuer、resource/audience、scope、撤销及本人微信绑定映射仍需实际实现；当前 dot 的可见关联走实际订阅聊天，不要求 signed personalDotId。私有 Tunnel 的条件性 NoAuthentication 路线另见 [架构核对](private-tunnel-architecture.md)，未由该接口启用。任意注入的 JavaScript callback 不能凭接口形状获得身份验证权威。它未自动接入 `resolveContext`，也没有 token、OAuth 或新 grant。[MCP 授权规范](https://modelcontextprotocol.io/specification/draft/basic/authorization)提供协议要求，不能提供本应用的用户映射。

## 多轮、容量与重启

微信客户端每批最多 128 条，累计保留最多 1024 条；backend 使用相同限额接受新批次与持久 pending 恢复。容量计数只纳入真正新增的合法本人消息，重复和拒绝数据不额外占用；有效新消息超过剩余容量时，整批不提交，也不推进游标。正常持久轮询在请求前及提交新游标前保存过期正文/回复上下文清理，保留防重和 UNKNOWN 记录。

这仍是有界会话：累计满 1024 条停止 GET；backend 的请求索引最多 256 条，journal 在防重留存窗内最多 256 条。客户端累计记录和 journal 当前留存记录不会仅因为重启而释放；backend 内存索引在实例重建时清空，旧关联能力也随之失效。不能通过删除状态或 UNKNOWN 记录延长服务。生产长期容量与保留策略尚未实现。

合成生命周期测试关闭并重开微信状态、加密 journal、backend 和事件适配器。旧 UNKNOWN 发送保持未知且不重发；没有重新验证订阅时拒绝新处理；重新验证后新一轮可沿新入站的原回复上下文完成。旧订阅、旧请求索引和旧回复能力不会自动恢复，当前安全策略是拒绝；它不满足官方订阅跨重启持久化要求。

真实持续多轮仍须验收已有目标 dot 的订阅、callback、工具调用和同一微信会话可见答案，以及获准断线/重启场景。当前没有创建或启用这些资源。

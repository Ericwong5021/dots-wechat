# HTTP resource-server gate candidate

This candidate implements the resource-server boundary only. It does not implement an OAuth authorization server, token issuing, refresh, registration, JWKS retrieval or signature verification. It does not create a tunnel or enable live WeChat effects. The unchanged CLI supplies no OAuth configuration and remains disabled for real effects.

`startLocalMcpService` accepts an optional `oauth` object containing `resourceUrl`, `issuer`, `authenticate`, and an optional `scopes` array. Configuration is supplied by the embedding application; no environment variable, deployment value or provider credential is guessed. Missing or invalid fields fail before a listener opens. An OAuth configuration cannot coexist with `resolveContext`.

`resourceUrl` is the actual canonical externally visible HTTPS `/mcp` endpoint and token audience. `issuer` is the exact canonical HTTPS authorization-server identifier selected by the owner. URLs must not contain credentials, query parameters or fragments; this implementation requires DNS names, rejects local host names and IP literals, and requires canonical URL serialization. These syntax checks do not prove domain ownership, provider authenticity or deployment readiness. The external trust configuration must establish those separately. The listener remains restricted to `127.0.0.1` and retains its Host, Origin and forwarding-header restrictions. A trusted tunnel must deliver the correct local Host without forwarding headers; this candidate does not relax that boundary.

Both exact GET routes `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` return the same bounded metadata document. It contains only the configured resource, issuer, header bearer method and explicitly supplied scopes. The HTTP 401 challenge advertises the `/mcp` metadata route. Other methods and route aliases are rejected. No authorization-server metadata is served locally: the real external issuer must provide its own discovery endpoint.

Every `/mcp` request is authenticated before the MCP SDK parses the body. Missing or malformed bearer credentials, verifier rejection and invalid verifier results receive HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="…"` and optional configured scope. Error bodies and challenges never interpolate token or exception details. Metadata is independent of client headers, `_meta`, protocol methods and chat content.

The trusted external callback contract is:

```js
authenticate({ bearerToken, request, resourceUrl, issuer, requiredScopes, signal })
```

`request` is a frozen object containing a new random `requestId`, the HTTP `method` and exact target `/mcp`. The callback receives the token only as input. It must verify it against configured trust anchors, exact issuer and audience, expiration and all required scopes, including revocation policy where applicable. It must reject by throwing or return precisely `{ context }`; `context` must be a fresh object for this single HTTP request. A reused context object is rejected. Return an immutable, independently verified capability or principal mapping suitable for the backend authorizer, never the raw token, a mutable shared principal, an API-key-present flag or a model-provided owner claim. Honor cancellation via `signal`. The gate does not manufacture or validate OAuth claims on the callback's behalf.

The server binds the verified context using an `AsyncLocalStorage` instance private to that service and captures that request's context for backend handlers. Different concurrent requests cannot replace each other's context. There is no module-level current-user variable, header-to-owner conversion or `_meta`-to-owner conversion. A completed, disconnected or timed-out request aborts the authentication signal; late verifier completion cannot enter the SDK or backend. Authentication counts toward the existing concurrency and request-time limits.

The backend's separate authorization checkpoints must still enforce exact tenant/owner/grant/binding/watch/generation/revision and existing-dot routing. An authenticated transport context is not authorization to reply. The parent integration must enforce the owner's concrete 30-minute lease and allowed text/reply operations, and must close its listener and tunnel on expiry. OAuth credentials and grants do not silently extend that lease.

Supply only the real minimum scopes issued by the chosen provider for this handshake. No scope names are invented here. If discovery and text/reply use different scopes, the embedding application must implement method/operation authorization in the trusted verifier/backend and advertise the actual provider scope design. Do not advertise broad `openid`, `email`, `profile` or write scopes unless the chosen identity flow requires and supports them.

Real integration remains blocked until the owner-approved resource URI, issuer/trust anchors, request-bound external token verifier, issuer discovery/PKCE client flow, and authenticated caller-to-owner/current-dot mapping are available. Synthetic tests prove local request isolation and fail-closed behavior only; they do not establish real identity, real OAuth handshake, an existing-dot subscription, callback acceptance or user-visible delivery.

Primary references: [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth) and [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization). They require protected-resource discovery and request token checks; provider discovery and the authorization-code/PKCE flow belong to the authorization server and client. `tunnel-client 0.0.14 --help` was inspected by the parent; its documented protected-resource lookup uses the `/mcp` suffix supported here. No tunnel-client OAuth execution was performed by this candidate.

Validation uses synthetic identifiers and tokens, injected verifiers and temporary loopback sockets. Run `node --test src/mcp/oauth-http.test.mjs src/mcp/http-guards.test.mjs src/mcp/server.test.mjs`; the full repository suite remains `npm test`. No new dependency is needed.

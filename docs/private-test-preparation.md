# Private, bounded text-test preparation

The default CLI remains disabled. These source modules do not create a Tunnel, install a connector, acquire a runtime key, subscribe a personal dot, poll WeChat or send a reply. No live test starts by importing a module or running `npm test`.

## Prepared local components

| Component | Implemented behavior | Evidence boundary |
| --- | --- | --- |
| OAuth HTTP gate | Protected-resource metadata, HTTP 401 challenge, request-isolated external verifier context and cancelled-request rejection | Requires a real issuer, verifier and caller mapping |
| Event wire and HTTPS callback | Exact signed bytes, fresh challenge validation, independently approved hostname, per-request public IPv4 resolution, pinned address/TLS name, no redirect or retry | Synthetic transport tests do not prove actual callback acceptance |
| Restricted backend | Explicit adapters, fixed lease, repeated authorization checkpoints, exact subscription/message correlation and UNKNOWN without automatic resend | Its factory mode configures interfaces; it does not establish a real dot |
| Session runner | New private temporary key files, loopback-only service contract, fixed wall/monotonic deadlines and native child-process shutdown | Health/discovery only; actual secure input and service adapters are absent |

No new dependency is required. The public project remains source-only; runtime evidence, keys, account/workspace IDs, QR material and chat content are excluded.

## Session runner and stop behavior

`src/session/session-runner.mjs` accepts only `health-discovery` evidence with real owner effects disabled. The evidence booleans are an operator-interface contract, not authenticated identity proof. Missing account/workspace/Tunnel/private-access evidence, secure secret input or execution adapters rejects startup. `assertEffectsAllowed()` always denies owner effects in this runner.

Use `createNativeWatchdog` only inside a newly spawned, dedicated runner for this single test. At its deadline it terminates that runner PID and its own Tunnel child. Never embed it directly in a shared IDE, Codex host or unrelated application. No installed start command invokes it automatically.

The runner calls `stop()` on SIGINT, SIGTERM, parent IPC disconnect, parentShutdown, failed startup and expiry. Stop synchronously aborts the operation signal and invokes the service's `disable()`, then bounds cleanup to 500 ms. The native watchdog handles an unresponsive runner independently. Session expiry is fixed once immediately before service activation and includes startup time; no refresh, restart or new subscription extends it. Sleep or kernel scheduling can delay user-space timers; wall and monotonic checks reject further effects on resumption.

The private-file adapter accepts a newly entered Buffer only through the injected `askSecret` interface. There is no built-in UI and no environment/history credential import. Its new temporary directory is mode 0700, and only its three own mode-0600 files are cleaned up. A dedicated stop path must retain the exact runner reference; do not use broad `killall`, historical PID lists, recursive credential deletion or launchd.

Local stop does not remove the remote Tunnel, connector, subscription or runtime key. The cloud operator must record actual unsubscribe/disconnect/delete or key-revoke results for the new test objects. Revocation of one object does not imply the others were removed.

## Required real values and trust

The cloud operator supplies exactly one newly created private Tunnel ID, verified org/workspace access and the actual externally visible HTTPS resource URI. The user enters a new minimum read/use runtime key through an approved secure input path; no key is sent in chat. The official client supports a file reference, not a secure-input UI supplied by this project.

```text
tunnel-client run
  --config /new/private/session/empty.yaml
  --control-plane.tunnel-id tunnel_NONSECRET_TEST_ID
  --control-plane.api-key file:/new/private/session/runtime-key
  --mcp.server-url http://127.0.0.1:8890/mcp
  --mcp.extra-headers "X-Dots-Local-Token: file:/new/private/session/local-token"
  --health.listen-addr 127.0.0.1:0
```

This is an unexecuted argv specification, not a paste-and-run launch command. `empty.yaml` contains `{}` to exclude old profiles. The child receives only PATH/HOME/TMPDIR/LANG; old secret, proxy and Node-option environment variables are omitted. No public local listener, managed Cloudflare companion or embedded MCP stub is enabled.

`X-Dots-Local-Token` is intended to authenticate this local runtime channel only; the actual service adapter must verify the exact token and reject duplicate or mismatched values. That adapter is not included in the runner. The token provides no account, tenant, current-dot or owner claim. Tunnel control-plane access likewise does not establish the identity required by the application. Verify the official connector's Host/header behavior without relaxing the loopback HTTP gate.

The implemented OAuth path needs an actual issuer and authenticated caller-to-owner mapping. OAuth is not mandatory for every private developer app: the conditional Tunnel-only NoAuthentication route and its unimplemented trust boundary are assessed in [the private architecture note](private-tunnel-architecture.md). No signed personalDotId is required; existing-dot association is tested in the actual subscribed chat. The HTTP resource gate is not an authorization server: it issues no code/token, performs no registration/PKCE/JWKS retrieval and does not create a grant. Supply the exact approved resource audience, issuer/trust anchors, real scopes, supported client/redirect flow, request-bound token verifier and all application principal fields. Do not substitute a constant owner context or a test verifier. Do not infer current-dot binding from a user-provided header, `_meta`, subscription arguments or successful Tunnel connection.

Discovery is served at `/.well-known/oauth-protected-resource/mcp` and the root equivalent. The selected external issuer must serve its own authorization-server metadata. Failure must produce an HTTP 401 challenge before the MCP SDK handles the request.

## Events and text acceptance

The event is `weixin.owner_message`; arguments bind the actual authorized `binding_id` and `generation`. An authorized `events/subscribe` supplies the platform's real webhook URL and secret. The application must independently trust the callback hostname; the submitted URL cannot authorize itself. Validate and sign the exact raw challenge/event bytes with the five Standard Webhooks headers, require the fresh challenge echo and bound 2xx response, and keep callback material out of logs and Git.

The only reply tool is `weixin.deliver_owner_reply`. It accepts the exact stored request/message/event/subscription/binding/generation correlation plus a new reply ID and bounded text. It selects no contact and cannot deliver media, operate a terminal or read files. Every await and irreversible commit must recheck the same finite lease and caller authorization; adapters must enforce the provided abort/lease at their own network and journal commit boundary.

API acceptance, callback acceptance, existing-dot tool execution and owner-visible delivery are separate evidence. Record all of them for the same fresh owner test message, then verify multiple varied turns, duplicates and controlled stop/restart. Old UNKNOWN sends are never automatically replayed. Subscriptions and request indexes are currently memory-only and deny replay after restart; automatic resubscription and durable restart continuity remain unverified.

## Primary references

[OpenAI Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [plugin authentication](https://developers.openai.com/plugins/build/auth), [MCP Events](https://developers.openai.com/plugins/build/mcp-events), [official tunnel-client v0.0.14 configuration](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/configuration.md), and [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization).

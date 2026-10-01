# HTTPS callback transport candidate

This candidate adds only a transport factory and synthetic tests. It does not start a listener, perform a request on import or factory creation, read credentials, create a subscription/grant, or enable the existing dot. No dependencies are added. The reviewed module is available at `src/mcp/https-callback-transport.mjs`; no CLI enables its network dependencies.

The exported `createHttpsCallbackTransport({ isTrustedHostname, resolve, request, timeoutMs })` returns the function expected by `createInjectedEventDelivery`. All three dependency functions are mandatory. `isTrustedHostname` is a synchronous, operator-controlled policy returning exactly `true` for an approved canonical hostname. It must not accept arbitrary subscription input as its own authority. The transport supports HTTPS port 443 only. A network endpoint creation permission is not callback authorization or a delivery secret.

`resolve(hostname, { all: true, family: 4, verbatim: true, signal })` must return an array of `{ address, family: 4 }` records. Every record is checked on every request. The first accepted address is passed as the request hostname, with no pooled agent, an address-pinned lookup, original SNI, original Host header, certificate verification enabled, and certificate identity explicitly checked against the original hostname. The injected `request(options, callback)` must be the Node `https.request` function in the eventual authorized runtime; a custom implementation that ignores options is outside this module's safety guarantee.

The request body is copied once as exact UTF-8 bytes or Uint8Array bytes, without parsing JSON or changing serialization. Only the five existing event-wire headers are accepted; Host, Content-Length, and Connection are supplied by the transport. Request and response bodies are each capped at 262,144 bytes, response headers at 16,384 bytes, and the deadline at 10,000 ms across DNS, connection and response. Shorter deadlines are supported for tests. Caller cancellation and timeout abort the internal signal and destroy open streams. Node's `dns.lookup` itself may continue after cancellation, but its late result cannot start a connection.

Every 3xx response is rejected without following Location. No retry occurs. Nonredirect response statuses and bounded raw response bytes are returned to the existing verification/outcome mapper. Errors contain fixed codes only, without external messages, causes, URL, request body or signature. The module has no logger. TLS, DNS and request failures do not establish delivery or acceptance.

IPv6 literals, all IP-literal URLs, and AAAA-only destinations are unsupported. A family-4 resolver can use the IPv4 side of a dual-stack hostname; no IPv6 validation claim is made. The IPv4 policy conservatively rejects all special-purpose ranges in the cited IANA registry, including globally reachable special-use exceptions, together with multicast. This is stricter than rejecting only private addresses and can reject valid special-use destinations. It does not infer actual route reachability or neutralize a malicious injected resolver/request function.

## Future runtime wiring

This is an unexecuted integration example. The application must first authenticate and authorize the real subscription, obtain its actual `delivery.url` and `delivery.secret`, provide its independently trusted hostname policy, enforce service/session expiry, and use its existing signed `event-wire` builders and callback challenge verification. The transport receives signed wire data; it never receives or generates a signing secret.

```js
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { createHttpsCallbackTransport } from './https-callback-transport.mjs';
import { createInjectedEventDelivery } from './injected-event-delivery.mjs';

export function buildAuthorizedDelivery(trustedHostnamePolicy) {
  const transport = createHttpsCallbackTransport({
    isTrustedHostname: trustedHostnamePolicy,
    resolve: lookup,
    request,
  });
  return createInjectedEventDelivery({ transport });
}
```

The existing adapter's `status()` still reports local injected evidence. Changing its transport is not proof of a real existing-dot subscription, callback acceptance, asynchronous dot execution, or a user-visible WeChat reply. Those require separate integration evidence.

## Pure test verification

```sh
node --test src/mcp/https-callback-transport.test.mjs
```

All fixtures use injected DNS and EventEmitter request/response fakes. The tests contain synthetic hostnames and body/signature material, and never import an HTTPS sender or DNS resolver. A fake public IPv4 address is an assertion input only. Node's certificate identity check is exercised on synthetic certificate metadata without a handshake.

## Primary references

[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), inspected 2026-10-01, specifies destination validation at connection time, connecting to a validated address with the original TLS hostname, public destination restrictions, no redirects, exact signed body bytes, and a 256 KiB request limit. Its Node example uses a 10-second AbortSignal deadline. Response/header limits and the conservative IPv4-only allow policy are local implementation decisions.

[IANA IPv4 Special-Purpose Address Space](https://www.iana.org/assignments/iana-ipv4-special-registry), registry last updated 2025-10-09, inspected 2026-10-01, supplies the special-purpose IPv4 ranges. [IANA IPv4 Multicast Address Space](https://www.iana.org/assignments/multicast-addresses/multicast-addresses.xhtml) supplies the additional 224.0.0.0/4 multicast exclusion.

[Node.js HTTPS](https://nodejs.org/docs/latest-v22.x/api/https.html) and [Node.js TLS certificate identity verification](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlscheckserveridentityhostname-cert) document the request and TLS options used here.

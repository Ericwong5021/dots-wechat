# Restricted test backend adapter contract

This candidate adds a source-level `restricted-test` factory interface. It does not install an identity provider, acquire credentials, create a tunnel, start a listener or start a real test session. The default remains `disabled`; the CLI has no new live switch. Synthetic tests prove code behavior only. They provide no evidence of trusted caller identity, a real existing personal dot, network access or user delivery.

`createLoopbackBackend()` preserves `disabled` and `injected-local`. `restricted-test` requires the existing journal, authorize, verifySubscription, publishEvent, Weixin client, correlation key and clock dependencies, plus the two immutable dependencies below. Missing configuration throws before any transport operation. Neither an `authorize` fixture nor a `verified: true` result can replace external caller authorization verification.

## Fixed operation lease

`operationLease` must be a frozen plain object with exactly two own data properties: `expiresAtMs` and `check`. Its deadline is a safe integer, strictly after the first factory clock reading and at most 1,800,000 ms after that reading. Accessors and mutable leases are rejected. The factory snapshots the deadline and check function; subscription refresh cannot extend it.

`check()` is synchronous. Returning `true` or `undefined` permits continuation. Returning `false`, returning any other value or throwing denies continuation. A Promise is rejected; an asynchronous lease cannot protect a synchronous effect boundary. The first rejection is permanent for this backend even if the external runner subsequently returns true. The clock is monotonic within the backend. The backend checks the fixed deadline before and after the external check itself.

The external runner owns the original enable time, one fixed hard stop, revocation, monotonic elapsed time and cancellation. A recreated factory must reuse the same original deadline. Creating a new frozen object or restarting the factory is not permission to reset the 30-minute session. A prepared or stopped runner must return false. A lease grants no caller identity or owner authorization.

## External caller authorization verifier

`restrictedAuthorization` must be a frozen plain object with exactly `issuer`, `audience` and `verify` as own data properties. The first two are pinned nonempty identifiers. They are local application configuration, not official OpenAI identity claims.

The backend invokes:

```js
restrictedAuthorization.verify(context, {
  purpose,
  requestId,
  authorization: { principal, expiresAtMs },
  operationLeaseExpiresAtMs
}, { signal, operationLease })
```

`requestId` is the exact opaque request for delivery and status operations, or null for operations without a request selector. The detail and nested authorization are frozen. The verifier must independently authenticate the actual credential in the caller context, validate its cryptographic signature or authoritative introspection, pinned issuer and audience, expiry, actual granted scope for `purpose`, revocation and server-controlled mapping to the full principal. It must check the request scope when supplied. A function existing, an input flag, a scope-shaped string or this application result object alone proves none of those facts.

The verifier returns exactly:

```js
{
  principal,
  expiresAtMs,
  purpose,
  requestId,
  checkedAtMs,
  issuer,
  audience,
  credentialId
}
```

The full principal and expiry must match `authorize` output. `purpose` and `requestId` must match this exact invocation. Issuer and audience must match the pinned configuration. `credentialId` is a nonempty opaque credential reference, not a raw token. `checkedAtMs` must lie between the start and completion of the current verification. Extra fields, stale timestamps, changed principals, changed expiry and `{ verified: true }` are rejected. The backend repeats this independent verification on every authorization checkpoint. It never publishes the verifier result or credential reference.

These fields are this application's adapter contract. No token parser, issuer discovery, signature verifier, provider grants or existing-dot identity implementation is supplied by this candidate. A synthetic verifier fabricating these fields must stay in synthetic tests. Do not enable a real restricted session until an actual trusted external verifier and owner mapping are installed. Wrapping the old injected-local authorizer with a function that copies its result into these fields is not a trusted verifier.

## Transport and commit enforcement

Verification, publication, Weixin ingress and sending receive `{ signal, operationLease }` as their options argument. Journal mutations receive `{ signal, operationLease, beforeCommit }` as a second argument while retaining the existing first argument and journal schema. Every mutation checks cancellation before inspection, after inspection and before commit, and after commit completion. After journal inspection and before invoking a mutation, it awaits `beforeCommit()` to renew caller authorization and check the active subscription. Cancellation uses an unsubscribe authorization guard without requiring an active subscription. The backend checks the lease at readiness, before and after authorization, on checkpoints, around journal inspection and mutation, immediately before transport effects and after their completion. Subscription deadlines and retained reply context deadlines are capped by the fixed lease.

Ingress status lookup is followed by renewed caller authorization and subscription checks both for duplicate results and missing requests, before any duplicate receipt or plaintext enqueue. Event receipt persistence, send receipt persistence and terminal reply lookup are followed by another authorization/subscription check before returning a receipt. Revocation while these journal operations await cannot produce a stale success response. When an effect has already occurred, the final rejection is `OUTCOME_UNKNOWN`. Journal cancellation completion is also followed by an authorization checkpoint.

Restricted subscriptions with an explicit positive `ttlMs` can cover up to the remaining fixed 30-minute lease, capped again by the caller authorization deadline. Omitted or null TTL retains the finite 10-minute default. The runner may request the remaining lifetime once at initial subscription; the backend creates no periodic refresh or new authorization. Injected-local subscriptions retain their original 10-minute maximum. Same-secret refresh never extends the global lease. Secret rotation remains explicitly unsupported, including after an in-process subscription expires. A changed secret is rejected; UNKNOWN outcomes are never automatically retried.

The live adapters must additionally enforce the lease immediately before issuing requests, propagate cancellation, bound waits and perform no automatic UNKNOWN retries. An already-issued request cannot be recalled by a later backend check. The existing raw Weixin client and `openJournal` do not implement the new second-argument guard contract; live assembly must provide guarded adapters. Journal persistence must execute the supplied `beforeCommit()` guard and enforce the same external lease, caller authorization and cancellation inside its actual commit boundary. An adapter may not treat an earlier backend preflight as permanent authorization. Backend checks before and after an arbitrary journal Promise cannot prevent a dependency from committing while it ignores cancellation or credential revocation. This candidate therefore supplies an interface, not a complete real-effects runner.

If an event or send completes after deadline or revocation, the backend throws with `outcome: OUTCOME_UNKNOWN` and `retryAutomatically: false`; it does not record late callback acceptance as success. The claimed attempt remains UNKNOWN. Status reads completing after invalidation cannot return success evidence. Lease failure denies further effects, including duplicate sends. A transport that never settles still needs the runner's bounded cancellation; backend close does not make arbitrary dependencies cancellable.

## Honest catalog and status semantics

| Surface | injected-local | restricted-test |
| --- | --- | --- |
| Factory mode | `injected-local` | `restricted-test` |
| Receipt evidence mode | `LOCAL_INJECTED_TRANSPORT` | `CONFIGURED_RESTRICTED_LIVE_TRANSPORT` |
| Receipt `liveEnabled` | false | true for a receipt returned while the lease is active |
| Health `liveEnabled` | false | whether the configured restricted path currently has an active lease |
| Reply output schema | local-only constants | constants matching the restricted receipt |
| Existing dot | `not_verified` | `not_verified` |
| Delivery confirmed in reply receipt | false | false |
| API acceptance | transport acceptance only | transport acceptance only |

`configured`, `publisherConfigured`, `weixinConfigured`, `liveEnabled` and the restricted evidence mode describe configuration and permission boundaries. They are not proof of an actual network exchange, OAuth identity, trusted issuer, existing personal dot subscription or user delivery. Health adds the fixed deadline, current lease activity, latched failure and `EXTERNAL_VERIFIER_REQUIRED_EACH_CHECKPOINT`; it never claims caller authentication has already occurred.

The exported `backendCatalog` retains its old local schema. Each restricted backend instance receives its own frozen catalog with matching receipt constants. `loopbackOperationSchemas` is unchanged. Gateway message status remains a journal projection, with `dot.existingDotBinding: NOT_VERIFIED_BY_THIS_MODULE`. A provider 2xx or callback acceptance cannot set user delivery to true. Separate correlated user/device evidence retains its existing status-reader contract; this backend does not establish existing-dot identity from it.

The shared Weixin boundaries remain `providerBatchMessages: 128` and `retainedMessages: 1024`. All old injected-local behavior remains supported. Run the focused synthetic suite with `node --test src/mcp/backend.test.mjs src/mcp/backend.restricted.test.mjs`.

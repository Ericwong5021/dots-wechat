import { createHmac } from 'node:crypto';
import { createGatewayStatusReader, gatewayStatusTool } from '../status/status.mjs';
import { WEIXIN_TEXT_LIMITS } from '../weixin/client.mjs';

const PRINCIPAL = ['tenantId', 'subject', 'grantId', 'bindingId', 'watchId', 'generation', 'revision'];
const CORRELATION = ['request_id', 'message_id', 'event_id', 'subscription_id', 'binding_id', 'generation'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, fields, required = fields) => plain(value) && Object.keys(value).every(key => fields.includes(key)) && required.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validPrincipal = value => exact(value, PRINCIPAL) && PRINCIPAL.every(key => ['generation', 'revision'].includes(key) ? integer(value[key]) && value[key] > 0 : id(value[key]));
const same = (a, b) => validPrincipal(a) && validPrincipal(b) && PRINCIPAL.every(key => a[key] === b[key]);
const textValid = (value, units, bytes) => typeof value === 'string' && value.trim().length > 0 && value.length <= units && Buffer.byteLength(value, 'utf8') <= bytes && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const demand = (value, code) => { if (!value) throw new LoopbackBackendError(code); };
const identSchema = { type: 'string', minLength: 1, maxLength: 512 };
const generationSchema = { type: 'integer', minimum: 1 };
const correlationProperties = Object.fromEntries(CORRELATION.map(key => [key, key === 'generation' ? generationSchema : identSchema]));
const immutable = (value, fields) => exact(value, fields) && Object.isFrozen(value) && fields.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.writable === false && descriptor.configurable === false; });
const verifierFields = ['principal', 'expiresAtMs', 'purpose', 'requestId', 'checkedAtMs', 'issuer', 'audience', 'credentialId'];

export const restrictedTestContract = freeze({ mode: 'restricted-test', maximumLeaseMs: 1800000, transportConfiguration: 'CONFIGURED_RESTRICTED_LIVE_TRANSPORT', authorizationEvidenceFields: verifierFields, leaseCheck: 'SYNCHRONOUS_THROW_OR_FALSE_DENIES', existingDot: 'not_verified', identityImplementation: 'EXTERNAL_VERIFIER_REQUIRED', runnerEnforcement: 'FIXED_DEADLINE_ABORT_TRANSPORT_AND_COMMIT_GUARDS_REQUIRED' });

export const loopbackOperationSchemas = freeze({
  subscribe: {
    type: 'object',
    properties: {
      name: { const: 'weixin.owner_message' },
      arguments: { type: 'object', properties: { binding_id: identSchema, generation: generationSchema }, required: ['binding_id', 'generation'], additionalProperties: false },
      delivery: { type: 'object', properties: { mode: { const: 'webhook' }, url: { type: 'string', maxLength: 2048 }, secret: { type: 'string' } }, required: ['mode', 'url', 'secret'], additionalProperties: false },
      ttlMs: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      cursor: { type: 'null' },
    },
    required: ['name', 'arguments', 'delivery'],
    additionalProperties: false,
  },
  unsubscribe: {
    type: 'object',
    properties: {
      name: { const: 'weixin.owner_message' },
      arguments: { type: 'object', properties: { binding_id: identSchema, generation: generationSchema }, required: ['binding_id', 'generation'], additionalProperties: false },
      delivery: { type: 'object', properties: { mode: { const: 'webhook' }, url: { type: 'string', maxLength: 2048 } }, required: ['mode', 'url'], additionalProperties: false },
    },
    required: ['name', 'arguments', 'delivery'],
    additionalProperties: false,
  },
});

export class LoopbackBackendError extends Error {
  constructor(code, outcome = 'NOT_STARTED') {
    super(code);
    this.name = 'LoopbackBackendError';
    this.code = code;
    this.outcome = outcome;
    this.retryAutomatically = false;
  }
}

export const backendCatalog = freeze({
  tools: [
    {
      name: 'weixin.deliver_owner_reply',
      description: 'Deliver one explicitly authorized reply to the exact owner conversation referenced by a previously published event. Never selects contacts. API acceptance is not delivery confirmation. Local injected transport only; no live provider is configured by this module.',
      inputSchema: { type: 'object', properties: { ...correlationProperties, reply_id: identSchema, text: { type: 'string', minLength: 1, maxLength: 800 } }, required: [...CORRELATION, 'reply_id', 'text'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { code: { enum: ['WEIXIN_API_ACCEPTED', 'WEIXIN_SEND_OUTCOME_UNKNOWN'] }, ...correlationProperties, retryAutomatically: { const: false }, liveEnabled: { const: false }, evidenceMode: { const: 'LOCAL_INJECTED_TRANSPORT' }, existingDot: { const: 'not_verified' }, deliveryConfirmed: { const: false } }, required: ['code', ...CORRELATION, 'retryAutomatically', 'liveEnabled', 'evidenceMode', 'existingDot', 'deliveryConfirmed'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    { ...gatewayStatusTool, description: 'Read authorized local gateway evidence for one request. Dot internal state is not exposed; transport acceptance is not user delivery.' },
  ],
  events: [{
    name: 'weixin.owner_message',
    description: 'Text from the single owner accepted by the injected WeChat client. Does not establish personal dot identity.',
    inputSchema: { type: 'object', properties: { binding_id: identSchema, generation: generationSchema }, required: ['binding_id', 'generation'], additionalProperties: false },
    payloadSchema: { type: 'object', properties: { ...correlationProperties, text: { type: 'string', minLength: 1, maxLength: 4000 } }, required: [...CORRELATION, 'text'], additionalProperties: false },
    delivery: ['webhook'],
  }],
  resources: [{ uri: 'dots-wechat://gateway/status', name: 'gateway_transport_status', description: 'Local service gates and capabilities only; no message or account details.', mimeType: 'application/json' }],
  resourceTemplates: [{ uriTemplate: 'dots-wechat://message/{request_id}/status', name: 'owner_message_status', description: 'Authorized gateway status for one opaque request reference.', mimeType: 'application/json' }],
});

export function createLoopbackBackend(options = {}) {
  const { mode = 'disabled', journal, authorize, verifySubscription, publishEvent, weixin, clock = Date.now, correlationKey, readEvidence = async () => [], readConnection = async () => null, operationLease, restrictedAuthorization } = options;
  demand(['disabled', 'injected-local', 'restricted-test'].includes(mode), 'LIVE_MODE_NOT_IMPLEMENTED');
  const restricted = mode === 'restricted-test';
  const configured = mode === 'injected-local' || restricted;
  if (configured) {
    demand(journal && ['inspect', 'inspectBinding', 'enqueue', 'claimDispatch', 'recordDispatch', 'queueReply', 'claimReply', 'recordReceipt', 'cancel', 'readStatus'].every(key => typeof journal[key] === 'function'), 'JOURNAL_REQUIRED');
    demand(typeof authorize === 'function' && typeof clock === 'function', 'AUTHORIZER_REQUIRED');
    demand(Buffer.isBuffer(correlationKey) && correlationKey.length === 32, 'CORRELATION_KEY_REQUIRED');
  }
  const secret = configured ? Buffer.from(correlationKey) : null;
  const subscriptions = new Map(), subscriptionLedger = new Map(), references = new Map(), contexts = new Map();
  let closed = false, highWater = -1, tail = Promise.resolve();
  const now = () => { const value = clock(); demand(integer(value) && value >= highWater, 'CLOCK_MOVED_BACKWARDS'); highWater = value; return value; };
  let leaseDeadline = null, leaseFailure = null, checkExternalLease = null, verifyExternalAuthorization = null, issuer = null, audience = null;
  if (restricted) {
    const factoryStartedAtMs = now();
    demand(immutable(operationLease, ['expiresAtMs', 'check']) && integer(operationLease.expiresAtMs) && operationLease.expiresAtMs > factoryStartedAtMs && operationLease.expiresAtMs - factoryStartedAtMs <= restrictedTestContract.maximumLeaseMs && typeof operationLease.check === 'function', 'OPERATION_LEASE_REQUIRED');
    demand(immutable(restrictedAuthorization, ['issuer', 'audience', 'verify']) && id(restrictedAuthorization.issuer) && id(restrictedAuthorization.audience) && typeof restrictedAuthorization.verify === 'function', 'EXTERNAL_AUTHORIZATION_VERIFIER_REQUIRED');
    demand(typeof verifySubscription === 'function' && typeof publishEvent === 'function' && weixin && ['getUpdates', 'pendingMessages', 'sendText'].every(key => typeof weixin[key] === 'function'), 'RESTRICTED_TRANSPORT_REQUIRED');
    leaseDeadline = operationLease.expiresAtMs;
    checkExternalLease = operationLease.check.bind(operationLease);
    verifyExternalAuthorization = restrictedAuthorization.verify.bind(restrictedAuthorization);
    issuer = restrictedAuthorization.issuer;
    audience = restrictedAuthorization.audience;
  }
  const checkLease = () => {
    if (!restricted) return;
    if (leaseFailure) throw new LoopbackBackendError(leaseFailure);
    try {
      demand(now() < leaseDeadline, 'OPERATION_LEASE_EXPIRED');
      const result = checkExternalLease();
      if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw new LoopbackBackendError('OPERATION_LEASE_CHECK_NOT_SYNCHRONOUS'); }
      demand(result === undefined || result === true, 'OPERATION_LEASE_REVOKED');
      demand(now() < leaseDeadline, 'OPERATION_LEASE_EXPIRED');
    } catch (error) {
      leaseFailure = error instanceof LoopbackBackendError ? error.code : 'OPERATION_LEASE_REVOKED';
      throw new LoopbackBackendError(leaseFailure);
    }
  };
  const signalCheck = signal => demand(!signal?.aborted, 'OPERATION_CANCELLED');
  const ready = () => { demand(configured && !closed, closed ? 'BACKEND_CLOSED' : 'BACKEND_NOT_CONFIGURED'); checkLease(); };
  const transportOptions = signal => restricted ? { signal, operationLease } : { signal };
  const prune = () => {
    const time = now();
    for (const [key, sub] of subscriptions) if (sub.expiresAtMs <= time) subscriptions.delete(key);
    for (const [key, value] of contexts) if (value.expiresAtMs <= time) contexts.delete(key);
  };
  const auth = async (context, purpose, signal, extra = {}) => {
    ready(); signalCheck(signal);
    let result;
    try { result = structuredClone(await authorize(context, freeze({ purpose, ...extra }))); }
    catch { throw new LoopbackBackendError('AUTHORIZATION_REJECTED'); }
    ready(); signalCheck(signal);
    const time = now();
    demand(exact(result, ['principal', 'expiresAtMs']) && validPrincipal(result.principal) && integer(result.expiresAtMs) && result.expiresAtMs > time && result.expiresAtMs <= time + 3600000, 'AUTHORIZATION_REJECTED');
    if (restricted) {
      const detail = freeze({ purpose, requestId: extra.requestId ?? null, authorization: result, operationLeaseExpiresAtMs: leaseDeadline });
      let verified;
      const startedAtMs = now();
      try { verified = structuredClone(await verifyExternalAuthorization(context, detail, transportOptions(signal))); }
      catch { checkLease(); throw new LoopbackBackendError('EXTERNAL_AUTHORIZATION_REJECTED'); }
      ready(); signalCheck(signal);
      demand(exact(verified, verifierFields) && same(verified.principal, result.principal) && verified.expiresAtMs === result.expiresAtMs && verified.purpose === purpose && verified.requestId === detail.requestId && verified.issuer === issuer && verified.audience === audience && id(verified.credentialId) && integer(verified.checkedAtMs) && verified.checkedAtMs >= startedAtMs && verified.checkedAtMs <= now() && verified.expiresAtMs > now(), 'EXTERNAL_AUTHORIZATION_REJECTED');
    }
    return freeze(result);
  };
  const checkpoint = async (initial, context, purpose, signal, extra = {}) => {
    const current = await auth(context, purpose, signal, extra);
    demand(same(current.principal, initial.principal) && current.expiresAtMs === initial.expiresAtMs, 'STALE_AUTHORIZATION');
    checkLease();
    return current;
  };
  const afterEffect = async (initial, context, purpose, signal, sub, extra = {}) => {
    try {
      await checkpoint(initial, context, purpose, signal, extra);
      ownedSubscription(sub.subscriptionId, initial);
    } catch (error) { throw new LoopbackBackendError(error?.code ?? 'STALE_EFFECT_COMPLETION', 'OUTCOME_UNKNOWN'); }
  };
  const serial = work => {
    if (closed) return Promise.reject(new LoopbackBackendError('BACKEND_CLOSED'));
    const task = tail.then(async () => {
      try { if (configured) prune(); return await work(); }
      catch (error) {
        if (error instanceof LoopbackBackendError) throw error;
        throw new LoopbackBackendError('DEPENDENCY_FAILURE', error?.outcome === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'NOT_STARTED');
      }
    });
    tail = task.catch(() => {});
    return task;
  };
  const mutation = async (method, principal, input, signal, beforeCommit) => {
    ready(); signalCheck(signal);
    const { commitRevision } = await journal.inspect();
    ready(); signalCheck(signal);
    demand(typeof beforeCommit === 'function', 'COMMIT_AUTHORIZATION_GUARD_REQUIRED');
    await beforeCommit();
    ready(); signalCheck(signal);
    const result = await journal[method]({ principal, ...input, expectedRevision: commitRevision }, { ...transportOptions(signal), beforeCommit });
    ready(); signalCheck(signal);
    return result;
  };
  const recordEffect = async (method, principal, input, signal, beforeCommit) => {
    try { return await mutation(method, principal, input, signal, beforeCommit); }
    catch { throw new LoopbackBackendError('EFFECT_RECORD_UNAVAILABLE', 'OUTCOME_UNKNOWN'); }
  };
  const ownedSubscription = (subscriptionId, authorization) => {
    checkLease();
    const sub = subscriptions.get(subscriptionId);
    demand(sub && sub.active && sub.expiresAtMs > now() && same(sub.principal, authorization.principal) && sub.authorizationExpiresAtMs === authorization.expiresAtMs, 'SUBSCRIPTION_INACTIVE');
    return sub;
  };
  const commitGuard = (initial, context, purpose, signal, sub, extra = {}) => async () => {
    await checkpoint(initial, context, purpose, signal, extra);
    if (sub) ownedSubscription(sub.subscriptionId, initial);
  };
  const ownerSub = authorization => {
    const matches = [...subscriptions.values()].filter(sub => sub.active && same(sub.principal, authorization.principal) && sub.expiresAtMs > now());
    demand(matches.length === 1, 'SUBSCRIPTION_REQUIRED');
    return ownedSubscription(matches[0].subscriptionId, authorization);
  };
  const correlation = row => ({ request_id: row.requestId, message_id: row.messageId, event_id: row.eventId, subscription_id: row.subscriptionId, binding_id: row.principal.bindingId, generation: row.principal.generation });
  const receipt = (row, code) => {
    try { checkLease(); } catch (error) { throw new LoopbackBackendError(error.code, 'OUTCOME_UNKNOWN'); }
    return freeze({ code, ...correlation(row), retryAutomatically: false, liveEnabled: restricted, evidenceMode: restricted ? 'CONFIGURED_RESTRICTED_LIVE_TRANSPORT' : 'LOCAL_INJECTED_TRANSPORT', existingDot: 'not_verified', deliveryConfirmed: false });
  };
  const canonicalCallback = value => {
    demand(typeof value === 'string' && value.length <= 2048, 'INVALID_DELIVERY');
    let url;
    try { url = new URL(value); } catch { throw new LoopbackBackendError('INVALID_DELIVERY'); }
    demand(url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.href.length <= 2048, 'INVALID_DELIVERY');
    return url.href;
  };
  const subscriptionIdentity = (principal, params) => `wx-sub:${createHmac('sha256', secret).update('dots-wechat-subscription/1\n').update(JSON.stringify([PRINCIPAL.map(key => principal[key]), params.name, params.delivery.url, params.arguments.binding_id, params.arguments.generation])).digest('hex')}`;
  const subscriptionRevision = subscriptionId => {
    let entry = subscriptionLedger.get(subscriptionId);
    if (!entry) {
      demand(subscriptionLedger.size < 256, 'SUBSCRIPTION_CAPACITY');
      entry = { revision: 0, secretDigest: null };
      subscriptionLedger.set(subscriptionId, entry);
    }
    return entry;
  };
  const validateSubscription = params => {
    demand(exact(params, ['name', 'arguments', 'delivery', 'ttlMs', 'cursor'], ['name', 'arguments', 'delivery']) && params.name === 'weixin.owner_message', 'INVALID_SUBSCRIPTION');
    demand(exact(params.arguments, ['binding_id', 'generation']) && id(params.arguments.binding_id) && integer(params.arguments.generation) && params.arguments.generation > 0, 'INVALID_SUBSCRIPTION');
    demand(exact(params.delivery, ['mode', 'url', 'secret']) && params.delivery.mode === 'webhook', 'INVALID_DELIVERY');
    params.delivery.url = canonicalCallback(params.delivery.url);
    const value = params.delivery.secret;
    demand(typeof value === 'string' && value.startsWith('whsec_'), 'INVALID_DELIVERY');
    const decoded = Buffer.from(value.slice(6), 'base64');
    demand(decoded.length >= 24 && decoded.length <= 64 && decoded.toString('base64') === value.slice(6), 'INVALID_DELIVERY');
    demand(params.cursor === undefined || params.cursor === null, 'REPLAY_NOT_IMPLEMENTED');
    demand(params.ttlMs === undefined || params.ttlMs === null || (integer(params.ttlMs) && params.ttlMs > 0), 'INVALID_TTL');
  };
  const statusReader = configured ? createGatewayStatusReader({
    authorize: (context, detail) => auth(context, detail.purpose, context?.signal, { requestId: detail.requestId }),
    resolveRequest: async ({ principal, requestId }) => {
      const reference = references.get(requestId);
      demand(reference && same(reference.principal, principal), 'REQUEST_SCOPE_MISMATCH');
      return structuredClone(reference);
    },
    readJournalStatus: input => journal.readStatus(input),
    readEvidence,
    readConnection,
    clock,
  }) : null;
  const status = () => {
    let leaseActive = false;
    if (restricted && !closed) { try { checkLease(); leaseActive = true; } catch {} }
    return freeze({ configured, closed, mode, liveEnabled: restricted && leaseActive, existingDot: 'not_verified', dotInternalState: 'NOT_EXPOSED', publisherConfigured: typeof publishEvent === 'function', weixinConfigured: Boolean(weixin), subscriptionPersistence: 'MEMORY_ONLY_RESTART_DENIES', requestIndexPersistence: 'MEMORY_ONLY_RESTART_DENIES', journalPersistence: configured ? 'INJECTED_JOURNAL' : 'NOT_CONFIGURED', automaticPolling: false, automaticRetry: false, ...(restricted ? { evidenceMode: 'CONFIGURED_RESTRICTED_LIVE_TRANSPORT', authorization: 'EXTERNAL_VERIFIER_REQUIRED_EACH_CHECKPOINT', operationLeaseExpiresAtMs: leaseDeadline, operationLeaseActive: leaseActive, operationLeaseFailure: leaseFailure } : {}) });
  };
  const catalog = restricted ? freeze({ ...backendCatalog, tools: backendCatalog.tools.map(tool => tool.name === 'weixin.deliver_owner_reply' ? { ...tool, description: 'Deliver one externally authorized reply through configured restricted live adapters under a fixed operation lease. Provider acceptance is not user delivery; this module does not establish existing dot identity.', outputSchema: { ...tool.outputSchema, properties: { ...tool.outputSchema.properties, liveEnabled: { const: true }, evidenceMode: { const: 'CONFIGURED_RESTRICTED_LIVE_TRANSPORT' } } } } : tool), events: backendCatalog.events.map(event => ({ ...event, description: 'Owner text accepted by the configured restricted WeChat adapter under an externally checked operation lease. Existing personal dot identity remains not verified.' })) }) : backendCatalog;
  const subscribe = (input, context, { signal } = {}) => serial(async () => {
    ready();
    let params;
    try { params = structuredClone(input); } catch { throw new LoopbackBackendError('INVALID_SUBSCRIPTION'); }
    validateSubscription(params);
    demand(typeof verifySubscription === 'function' && typeof publishEvent === 'function' && weixin && ['getUpdates', 'pendingMessages', 'sendText'].every(key => typeof weixin[key] === 'function'), 'SUBSCRIPTION_TRANSPORT_NOT_CONFIGURED');
    const initial = await auth(context, 'weixin.events.subscribe', signal);
    demand(params.arguments.binding_id === initial.principal.bindingId && params.arguments.generation === initial.principal.generation, 'BINDING_MISMATCH');
    const binding = await journal.inspectBinding({ watchId: initial.principal.watchId });
    await checkpoint(initial, context, 'weixin.events.subscribe', signal);
    demand(binding.active && binding.generationFloor === initial.principal.generation && binding.revisionFloor === initial.principal.revision, 'STALE_BINDING');
    const subscriptionId = subscriptionIdentity(initial.principal, params);
    const current = subscriptionRevision(subscriptionId);
    const expectedRevision = current.revision;
    const secretDigest = createHmac('sha256', secret).update('dots-wechat-subscription-secret/1\n').update(params.delivery.secret).digest('hex');
    demand(current.secretDigest === null || current.secretDigest === secretDigest, 'SECRET_ROTATION_NOT_IMPLEMENTED');
    current.secretDigest = secretDigest;
    const existing = subscriptions.get(subscriptionId);
    demand(!existing || existing.authorizationExpiresAtMs === initial.expiresAtMs, 'STALE_AUTHORIZATION');
    const other = [...subscriptions.values()].find(sub => sub.active && sub.subscriptionId !== subscriptionId && same(sub.principal, initial.principal) && sub.expiresAtMs > now());
    demand(!other, 'SUBSCRIPTION_CONFLICT');
    const expiresAtMs = Math.min(initial.expiresAtMs, leaseDeadline ?? Number.MAX_SAFE_INTEGER, now() + Math.min(params.ttlMs ?? 600000, restricted ? restrictedTestContract.maximumLeaseMs : 600000));
    const candidate = freeze({ subscriptionId, principal: initial.principal, authorizationExpiresAtMs: initial.expiresAtMs, expiresAtMs, delivery: params.delivery });
    checkLease();
    const verified = await verifySubscription(candidate, transportOptions(signal));
    await checkpoint(initial, context, 'weixin.events.subscribe', signal);
    demand(verified?.verified === true && now() < expiresAtMs, 'CALLBACK_NOT_VERIFIED');
    demand(subscriptionRevision(subscriptionId).revision === expectedRevision, 'SUBSCRIPTION_CHANGED');
    subscriptions.set(subscriptionId, { ...candidate, active: true });
    checkLease();
    return freeze({ subscriptionId, expiresAtMs, replayed: false, liveEnabled: restricted });
  });
  const unsubscribe = async (input, context, { signal } = {}) => {
    ready();
    let params;
    try { params = structuredClone(input); } catch { throw new LoopbackBackendError('INVALID_UNSUBSCRIBE'); }
    demand(exact(params, ['name', 'arguments', 'delivery']) && params.name === 'weixin.owner_message' && exact(params.arguments, ['binding_id', 'generation']) && id(params.arguments.binding_id) && integer(params.arguments.generation) && params.arguments.generation > 0 && exact(params.delivery, ['mode', 'url']) && params.delivery.mode === 'webhook', 'INVALID_UNSUBSCRIBE');
    params.delivery.url = canonicalCallback(params.delivery.url);
    const initial = await auth(context, 'weixin.events.unsubscribe', signal);
    demand(params.arguments.binding_id === initial.principal.bindingId && params.arguments.generation === initial.principal.generation, 'BINDING_MISMATCH');
    const subscriptionId = subscriptionIdentity(initial.principal, params);
    const current = subscriptionRevision(subscriptionId);
    demand(current.revision < Number.MAX_SAFE_INTEGER, 'SUBSCRIPTION_REVISION_EXHAUSTED');
    current.revision++;
    const sub = subscriptions.get(subscriptionId);
    if (!sub?.active) return freeze({ unsubscribed: true, subscriptionId, remoteRevocation: 'not_attempted' });
    sub.active = false;
    return serial(async () => {
      const beforeCommit = commitGuard(initial, context, 'weixin.events.unsubscribe', signal);
      const targets = [...references.values()].filter(reference => reference.subscriptionId === sub.subscriptionId);
      for (const target of targets) {
        await checkpoint(initial, context, 'weixin.events.unsubscribe', signal);
        await mutation('cancel', initial.principal, { requestId: target.requestId }, signal, beforeCommit);
        await checkpoint(initial, context, 'weixin.events.unsubscribe', signal);
        contexts.delete(target.requestId);
      }
      return freeze({ unsubscribed: true, subscriptionId: sub.subscriptionId, remoteRevocation: 'not_attempted' });
    });
  };
  const pollOwner = (context, { signal, pendingOnly = false } = {}) => serial(async () => {
    const initial = await auth(context, 'weixin.owner.ingress', signal);
    const sub = ownerSub(initial);
    const beforeCommit = commitGuard(initial, context, 'weixin.owner.ingress', signal, sub);
    demand(weixin && typeof publishEvent === 'function', 'INGRESS_TRANSPORT_NOT_CONFIGURED');
    checkLease();
    const batch = await weixin[pendingOnly ? 'pendingMessages' : 'getUpdates'](transportOptions(signal));
    await checkpoint(initial, context, 'weixin.owner.ingress', signal);
    ownedSubscription(sub.subscriptionId, initial);
    demand(batch?.status === 'OK' && Array.isArray(batch.messages) && batch.messages.length <= (pendingOnly ? WEIXIN_TEXT_LIMITS.retainedMessages : WEIXIN_TEXT_LIMITS.providerBatchMessages), 'WEIXIN_INGRESS_UNAVAILABLE');
    const results = [];
    for (const inbound of batch.messages) {
      demand(plain(inbound) && id(inbound.messageId) && textValid(inbound.text, 4000, 16000), 'INVALID_INBOUND_CAPABILITY');
      await checkpoint(initial, context, 'weixin.owner.ingress', signal);
      ownedSubscription(sub.subscriptionId, initial);
      const digest = createHmac('sha256', secret).update(JSON.stringify([initial.principal.tenantId, initial.principal.subject, initial.principal.bindingId, initial.principal.generation, inbound.messageId])).digest('hex');
      const reference = freeze({ principal: initial.principal, requestId: `wx-request:${digest}`, messageId: `wx-message:${digest}`, eventId: `wx-event:${digest}`, subscriptionId: sub.subscriptionId, receivedAtMs: now() });
      let prior;
      try { prior = await journal.readStatus({ tenantId: initial.principal.tenantId, subject: initial.principal.subject, requestId: reference.requestId }); }
      catch (error) { if (error?.code !== 'REQUEST_NOT_FOUND') throw error; }
      await checkpoint(initial, context, 'weixin.owner.ingress', signal);
      ownedSubscription(sub.subscriptionId, initial);
      if (prior) {
        await checkpoint(initial, context, 'weixin.owner.ingress', signal);
        ownedSubscription(sub.subscriptionId, initial);
        demand(prior.generation === initial.principal.generation && prior.authorizationRevision === initial.principal.revision, 'STALE_REQUEST');
        results.push(receipt({ ...reference, messageId: prior.messageId, eventId: prior.eventId, subscriptionId: prior.subscriptionId }, 'DUPLICATE_NOT_REPLAYED'));
        continue;
      }
      demand(references.size < 256, 'REQUEST_INDEX_CAPACITY');
      const ids = { requestId: reference.requestId, messageId: reference.messageId, eventId: reference.eventId, subscriptionId: reference.subscriptionId };
      await checkpoint(initial, context, 'weixin.owner.ingress', signal);
      ownedSubscription(sub.subscriptionId, initial);
      const enqueued = await mutation('enqueue', initial.principal, { ...ids, text: inbound.text }, signal, beforeCommit);
      references.set(reference.requestId, reference);
      contexts.set(reference.requestId, { inbound, expiresAtMs: Math.min(enqueued.payloadExpiresAt, leaseDeadline ?? Number.MAX_SAFE_INTEGER) });
      await checkpoint(initial, context, 'weixin.owner.ingress', signal);
      ownedSubscription(sub.subscriptionId, initial);
      const claimed = await mutation('claimDispatch', initial.principal, { requestId: reference.requestId }, signal, beforeCommit);
      await checkpoint(initial, context, 'weixin.owner.ingress', signal);
      ownedSubscription(sub.subscriptionId, initial);
      demand(now() < claimed.payloadExpiresAt, 'PAYLOAD_EXPIRED');
      let outcome = 'OUTCOME_UNKNOWN';
      checkLease();
      try {
        const published = await publishEvent(freeze({ eventId: reference.eventId, name: 'weixin.owner_message', timestamp: new Date(reference.receivedAtMs).toISOString(), data: { ...correlation(reference), text: claimed.text }, cursor: null }), freeze({ ...sub }), transportOptions(signal));
        if (exact(published, ['outcome']) && ['ACCEPTED', 'REJECTED', 'OUTCOME_UNKNOWN'].includes(published.outcome)) outcome = published.outcome;
      } catch {}
      await afterEffect(initial, context, 'weixin.owner.ingress', signal, sub);
      await recordEffect('recordDispatch', initial.principal, { requestId: reference.requestId, attemptId: claimed.dispatchAttemptId, outcome }, signal, beforeCommit);
      await afterEffect(initial, context, 'weixin.owner.ingress', signal, sub);
      if (outcome === 'REJECTED') contexts.delete(reference.requestId);
      results.push(receipt(reference, `MCP_EVENT_${outcome}`));
    }
    checkLease();
    return freeze({ messages: results, rejectedCount: integer(batch.rejectedCount) ? batch.rejectedCount : 0, liveEnabled: restricted });
  });
  const deliver = (input, context, { signal } = {}) => serial(async () => {
    demand(exact(input, [...CORRELATION, 'reply_id', 'text']) && CORRELATION.filter(key => key !== 'generation').every(key => id(input[key])) && id(input.reply_id) && integer(input.generation) && input.generation > 0 && textValid(input.text, 800, 2048), 'INVALID_REPLY_ARGUMENTS');
    const args = freeze(structuredClone(input));
    const initial = await auth(context, 'weixin.message.deliver', signal, { requestId: args.request_id });
    const reference = references.get(args.request_id);
    demand(reference && same(reference.principal, initial.principal) && CORRELATION.every(key => correlation(reference)[key] === args[key]), 'CORRELATION_MISMATCH');
    const sub = ownedSubscription(reference.subscriptionId, initial);
    const beforeCommit = commitGuard(initial, context, 'weixin.message.deliver', signal, sub, { requestId: args.request_id });
    demand(weixin && typeof weixin.sendText === 'function', 'WEIXIN_SEND_NOT_CONFIGURED');
    const queued = await mutation('queueReply', initial.principal, { requestId: reference.requestId, messageId: reference.messageId, eventId: reference.eventId, subscriptionId: reference.subscriptionId, replyId: args.reply_id, text: args.text }, signal, beforeCommit);
    if (['OUTCOME_UNKNOWN', 'RECEIPT_RECORDED'].includes(queued.downlink)) {
      await afterEffect(initial, context, 'weixin.message.deliver', signal, sub, { requestId: args.request_id });
      return receipt(reference, queued.downlink === 'OUTCOME_UNKNOWN' ? 'WEIXIN_SEND_OUTCOME_UNKNOWN' : 'WEIXIN_API_ACCEPTED');
    }
    const destination = contexts.get(reference.requestId);
    demand(destination && now() < destination.expiresAtMs, 'REPLY_CONTEXT_UNAVAILABLE');
    await checkpoint(initial, context, 'weixin.message.deliver', signal, { requestId: args.request_id });
    ownedSubscription(reference.subscriptionId, initial);
    const claimed = await mutation('claimReply', initial.principal, { requestId: reference.requestId }, signal, beforeCommit);
    await checkpoint(initial, context, 'weixin.message.deliver', signal, { requestId: args.request_id });
    ownedSubscription(reference.subscriptionId, initial);
    demand(now() < claimed.payloadExpiresAt, 'PAYLOAD_EXPIRED');
    let sent;
    checkLease();
    try { sent = await weixin.sendText({ inbound: destination.inbound, text: claimed.text }, transportOptions(signal)); } catch { sent = { status: 'OUTCOME_UNKNOWN' }; }
    await afterEffect(initial, context, 'weixin.message.deliver', signal, sub, { requestId: args.request_id });
    contexts.delete(reference.requestId);
    if (sent?.status !== 'API_ACCEPTED') return receipt(reference, 'WEIXIN_SEND_OUTCOME_UNKNOWN');
    await recordEffect('recordReceipt', initial.principal, { requestId: reference.requestId, replyId: args.reply_id, attemptId: claimed.deliveryAttemptId }, signal, beforeCommit);
    await afterEffect(initial, context, 'weixin.message.deliver', signal, sub, { requestId: args.request_id });
    return receipt(reference, 'WEIXIN_API_ACCEPTED');
  });
  const callTool = async (name, args, context, options = {}) => {
    ready(); signalCheck(options.signal);
    if (name === 'weixin.deliver_owner_reply') return deliver(args, context, options);
    demand(name === 'weixin.get_message_status', 'TOOL_NOT_FOUND');
    let value;
    try { value = await statusReader.read(args, context); } catch (error) { checkLease(); throw error; }
    ready(); signalCheck(options.signal);
    return value;
  };
  const readResource = async (uri, context, options = {}) => {
    signalCheck(options.signal);
    if (uri === 'dots-wechat://gateway/status') return status();
    demand(typeof uri === 'string' && /^dots-wechat:\/\/message\/[^/]+\/status$/u.test(uri), 'RESOURCE_NOT_FOUND');
    let request_id;
    try { request_id = decodeURIComponent(uri.slice('dots-wechat://message/'.length, -'/status'.length)); } catch { throw new LoopbackBackendError('RESOURCE_NOT_FOUND'); }
    return callTool('weixin.get_message_status', { request_id }, context, options);
  };
  return Object.freeze({
    catalog,
    status,
    listEvents: async () => ({ events: catalog.events }),
    subscribe,
    unsubscribe,
    pollOwner,
    callTool,
    readResource,
    async close() {
      closed = true;
      await tail;
      subscriptions.clear(); subscriptionLedger.clear(); references.clear(); contexts.clear(); secret?.fill(0);
    },
  });
}

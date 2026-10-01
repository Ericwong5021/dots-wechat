const PRINCIPAL_KEYS = ['tenantId', 'subject', 'grantId', 'bindingId', 'watchId', 'generation', 'revision'];
const CORRELATION_KEYS = ['requestId', 'messageId', 'eventId', 'subscriptionId'];
const UPLINK = ['READY', 'OUTCOME_UNKNOWN', 'ACCEPTED', 'REJECTED', 'CANCELLED'];
const DOWNLINK = ['AWAITING_REPLY', 'QUEUED', 'OUTCOME_UNKNOWN', 'RECEIPT_RECORDED', 'CANCELLED'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
const validPrincipal = value => exact(value, PRINCIPAL_KEYS) && PRINCIPAL_KEYS.every(key => ['generation', 'revision'].includes(key) ? integer(value[key]) && value[key] > 0 : id(value[key]));
const equalPrincipal = (a, b) => validPrincipal(a) && validPrincipal(b) && PRINCIPAL_KEYS.every(key => a[key] === b[key]);
const demand = (condition, code) => { if (!condition) throw new GatewayStatusError(code); };
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const validReference = value => exact(value, ['principal', ...CORRELATION_KEYS, 'receivedAtMs']) && validPrincipal(value.principal) && CORRELATION_KEYS.every(key => id(value[key])) && (value.receivedAtMs === null || integer(value.receivedAtMs));

export class GatewayStatusError extends Error {
  constructor(code) { super(code); this.name = 'GatewayStatusError'; this.code = code; this.retryAutomatically = false; }
}

export const gatewayStatusOutputSchema = freeze({
  type: 'object',
  properties: {
    schemaVersion: { const: 1 },
    requestId: { type: 'string' },
    state: { enum: ['RECEIVED', 'PROCESSING', 'WAITING_CONFIRMATION', 'COMPLETED', 'FAILED'] },
    reason: { enum: ['USER_VISIBLE_CONFIRMATION', 'DEVICE_RECEIPT', 'OUTCOME_UNKNOWN', 'RECEIPT_SEMANTICS_NOT_USER_DELIVERY', 'UPSTREAM_REJECTED', 'CANCELLED', 'PAYLOAD_EXPIRED', 'REPLY_QUEUED_BY_GATEWAY', 'EVENT_ACCEPTED_NOT_DOT_STATE', 'QUEUED_IN_GATEWAY'] },
    source: { const: 'LOCAL_GATEWAY_JOURNAL_PROJECTION' },
    observedAtMs: { type: 'integer', minimum: 0 },
    journalReadAtMs: { type: 'integer', minimum: 0 },
    receivedAtMs: { type: ['integer', 'null'], minimum: 0 },
    stateChangedAtMs: { type: ['integer', 'null'], minimum: 0 },
    payloadExpiresAtMs: { type: 'integer', minimum: 0 },
    retainedUntilMs: { type: 'integer', minimum: 0 },
    expired: { type: 'boolean' },
    retryAutomatically: { const: false },
    hasUnknownOutcome: { type: 'boolean' },
    journal: { type: 'object', properties: { uplink: { enum: UPLINK }, downlink: { enum: DOWNLINK }, cancelled: { type: 'boolean' } }, required: ['uplink', 'downlink', 'cancelled'], additionalProperties: false },
    completionEvidence: { anyOf: [{ type: 'null' }, { type: 'object', properties: { kind: { enum: ['USER_VISIBLE_CONFIRMATION', 'DEVICE_RECEIPT'] }, observedAtMs: { type: 'integer', minimum: 0 } }, required: ['kind', 'observedAtMs'], additionalProperties: false }] },
    connection: { type: 'object', properties: { component: { enum: ['wechat', 'mcp'] }, state: { enum: ['UNKNOWN', 'DISABLED', 'AVAILABLE', 'UNAVAILABLE'] }, source: { enum: ['NO_TRANSPORT_OBSERVATION', 'TRANSPORT_ADAPTER_OBSERVATION', 'STALE_TRANSPORT_OBSERVATION'] }, observedAtMs: { type: ['integer', 'null'], minimum: 0 }, freshUntilMs: { type: ['integer', 'null'], minimum: 0 } }, required: ['state', 'source', 'observedAtMs', 'freshUntilMs'], additionalProperties: false },
    dot: { type: 'object', properties: { internalState: { const: 'NOT_EXPOSED' }, existingDotBinding: { const: 'NOT_VERIFIED_BY_THIS_MODULE' } }, required: ['internalState', 'existingDotBinding'], additionalProperties: false },
  },
  required: ['schemaVersion', 'requestId', 'state', 'reason', 'source', 'observedAtMs', 'journalReadAtMs', 'receivedAtMs', 'stateChangedAtMs', 'payloadExpiresAtMs', 'retainedUntilMs', 'expired', 'retryAutomatically', 'hasUnknownOutcome', 'journal', 'completionEvidence', 'connection', 'dot'],
  additionalProperties: false,
});

export const gatewayStatusTool = freeze({
  name: 'weixin.get_message_status',
  description: 'Proposed local gateway status reader. Reports gateway evidence for one authorized request; does not report dot presence, thinking, reading or internal completion. This tool is not registered or network-enabled.',
  inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['request_id'], additionalProperties: false },
  outputSchema: gatewayStatusOutputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
});

function projectConnection(observation, principal, now) {
  if (observation === null) return { state: 'UNKNOWN', source: 'NO_TRANSPORT_OBSERVATION', observedAtMs: null, freshUntilMs: null };
  demand(exact(observation, ['principal', 'component', 'state', 'observedAtMs', 'freshUntilMs']) && equalPrincipal(observation.principal, principal), 'CONNECTION_SCOPE_MISMATCH');
  demand(['wechat', 'mcp'].includes(observation.component) && ['DISABLED', 'AVAILABLE', 'UNAVAILABLE'].includes(observation.state), 'INVALID_CONNECTION_OBSERVATION');
  demand(integer(observation.observedAtMs) && integer(observation.freshUntilMs) && observation.observedAtMs <= now && observation.freshUntilMs > observation.observedAtMs && observation.freshUntilMs - observation.observedAtMs <= 60000, 'INVALID_CONNECTION_TIME');
  return { component: observation.component, state: now < observation.freshUntilMs ? observation.state : 'UNKNOWN', source: now < observation.freshUntilMs ? 'TRANSPORT_ADAPTER_OBSERVATION' : 'STALE_TRANSPORT_OBSERVATION', observedAtMs: observation.observedAtMs, freshUntilMs: observation.freshUntilMs };
}

function confirmationFrom(evidence, reference, record, now) {
  demand(Array.isArray(evidence) && evidence.length <= 16, 'INVALID_EVIDENCE');
  let confirmation = null;
  for (const item of evidence) {
    demand(exact(item, ['principal', ...CORRELATION_KEYS, 'replyId', 'deliveryAttemptId', 'kind', 'observedAtMs']), 'INVALID_EVIDENCE');
    demand(equalPrincipal(item.principal, reference.principal) && CORRELATION_KEYS.every(key => item[key] === reference[key]) && item.replyId === record.replyId && item.deliveryAttemptId === record.deliveryAttemptId && id(item.replyId) && id(item.deliveryAttemptId), 'EVIDENCE_SCOPE_MISMATCH');
    demand(['USER_VISIBLE_CONFIRMATION', 'DEVICE_RECEIPT'].includes(item.kind), 'UNSUPPORTED_CONFIRMATION');
    demand(integer(item.observedAtMs) && item.observedAtMs <= now && (reference.receivedAtMs === null || item.observedAtMs >= reference.receivedAtMs), 'INVALID_EVIDENCE_TIME');
    demand(['OUTCOME_UNKNOWN', 'RECEIPT_RECORDED'].includes(record.downlink), 'NO_DELIVERY_ATTEMPT');
    if (!confirmation || item.observedAtMs < confirmation.observedAtMs) confirmation = { kind: item.kind, observedAtMs: item.observedAtMs };
  }
  return confirmation;
}

export function projectJournalStatus({ record, reference, evidence = [], connection = null, observedAtMs, journalReadAtMs = observedAtMs } = {}) {
  demand(integer(observedAtMs), 'INVALID_CLOCK');
  demand(integer(journalReadAtMs) && journalReadAtMs <= observedAtMs, 'INVALID_SNAPSHOT_TIME');
  demand(validReference(reference), 'INVALID_REFERENCE');
  demand(plain(record) && CORRELATION_KEYS.every(key => record[key] === reference[key]), 'CORRELATION_MISMATCH');
  demand(record.generation === reference.principal.generation && record.authorizationRevision === reference.principal.revision, 'STALE_GENERATION_OR_REVISION');
  demand(UPLINK.includes(record.uplink) && DOWNLINK.includes(record.downlink) && typeof record.cancelled === 'boolean' && record.retryAutomatically === false, 'INVALID_JOURNAL_STATUS');
  demand(integer(record.payloadExpiresAt) && integer(record.tombstoneUntil) && record.payloadExpiresAt <= record.tombstoneUntil && (reference.receivedAtMs === null || reference.receivedAtMs <= Math.min(record.payloadExpiresAt, observedAtMs)), 'INVALID_RECORD_TIME');
  demand(observedAtMs < record.tombstoneUntil, 'STATUS_RETENTION_EXPIRED');
  demand(['dispatchAttemptId', 'deliveryAttemptId', 'replyId'].every(key => record[key] === null || id(record[key])), 'INVALID_ATTEMPT');
  demand(!['OUTCOME_UNKNOWN', 'ACCEPTED', 'REJECTED'].includes(record.uplink) || id(record.dispatchAttemptId), 'INVALID_ATTEMPT');
  demand(!['OUTCOME_UNKNOWN', 'RECEIPT_RECORDED'].includes(record.downlink) || (id(record.deliveryAttemptId) && id(record.replyId)), 'INVALID_ATTEMPT');
  demand(record.downlink !== 'QUEUED' || id(record.replyId), 'INVALID_ATTEMPT');
  const expired = observedAtMs >= record.payloadExpiresAt;
  const unknown = record.uplink === 'OUTCOME_UNKNOWN' || record.downlink === 'OUTCOME_UNKNOWN';
  const confirmation = confirmationFrom(evidence, reference, record, observedAtMs);
  let state, reason;
  if (record.cancelled) { state = unknown ? 'WAITING_CONFIRMATION' : 'FAILED'; reason = unknown ? 'OUTCOME_UNKNOWN' : 'CANCELLED'; }
  else if (confirmation) { state = 'COMPLETED'; reason = confirmation.kind; }
  else if (record.downlink === 'OUTCOME_UNKNOWN' || (expired && unknown) || (record.uplink === 'OUTCOME_UNKNOWN' && record.downlink !== 'QUEUED' && record.downlink !== 'RECEIPT_RECORDED')) { state = 'WAITING_CONFIRMATION'; reason = 'OUTCOME_UNKNOWN'; }
  else if (record.downlink === 'RECEIPT_RECORDED') { state = 'WAITING_CONFIRMATION'; reason = 'RECEIPT_SEMANTICS_NOT_USER_DELIVERY'; }
  else if (record.uplink === 'REJECTED') { state = 'FAILED'; reason = 'UPSTREAM_REJECTED'; }
  else if (expired) { state = 'FAILED'; reason = 'PAYLOAD_EXPIRED'; }
  else if (record.downlink === 'CANCELLED' || record.uplink === 'CANCELLED') { state = 'FAILED'; reason = 'CANCELLED'; }
  else if (record.downlink === 'QUEUED') { state = 'PROCESSING'; reason = 'REPLY_QUEUED_BY_GATEWAY'; }
  else if (record.uplink === 'ACCEPTED') { state = 'PROCESSING'; reason = 'EVENT_ACCEPTED_NOT_DOT_STATE'; }
  else { state = 'RECEIVED'; reason = 'QUEUED_IN_GATEWAY'; }
  return freeze({
    schemaVersion: 1,
    requestId: reference.requestId,
    state,
    reason,
    source: 'LOCAL_GATEWAY_JOURNAL_PROJECTION',
    observedAtMs,
    journalReadAtMs,
    receivedAtMs: reference.receivedAtMs,
    stateChangedAtMs: state === 'COMPLETED' ? confirmation.observedAtMs : null,
    payloadExpiresAtMs: record.payloadExpiresAt,
    retainedUntilMs: record.tombstoneUntil,
    expired,
    retryAutomatically: false,
    hasUnknownOutcome: unknown,
    journal: { uplink: record.uplink, downlink: record.downlink, cancelled: record.cancelled },
    completionEvidence: confirmation,
    connection: projectConnection(connection, reference.principal, observedAtMs),
    dot: { internalState: 'NOT_EXPOSED', existingDotBinding: 'NOT_VERIFIED_BY_THIS_MODULE' },
  });
}

export function createGatewayStatusReader(options = {}) {
  if (Object.keys(options).length === 0) return Object.freeze({ status: () => ({ configured: false, networkStarted: false }), read: async () => { throw new GatewayStatusError('STATUS_READER_NOT_CONFIGURED'); } });
  const { authorize, resolveRequest, readJournalStatus, readEvidence = async () => [], readConnection = async () => null, clock = Date.now } = options;
  demand([authorize, resolveRequest, readJournalStatus, readEvidence, readConnection, clock].every(value => typeof value === 'function'), 'TRUSTED_DEPENDENCIES_REQUIRED');
  let highWater = -1;
  const tick = () => { const now = clock(); demand(integer(now) && now >= highWater, 'CLOCK_MOVED_BACKWARDS'); highWater = now; return now; };
  const auth = async (context, requestId) => {
    let value;
    try { value = structuredClone(await authorize(context, Object.freeze({ purpose: 'gateway.status.read', requestId }))); }
    catch { throw new GatewayStatusError('AUTHORIZATION_REJECTED'); }
    demand(exact(value, ['principal', 'expiresAtMs']) && validPrincipal(value.principal) && integer(value.expiresAtMs) && value.expiresAtMs > tick(), 'AUTHORIZATION_REJECTED');
    return freeze(value);
  };
  const read = async (input, context) => {
    try {
      demand(exact(input, ['request_id']) && id(input.request_id), 'INVALID_STATUS_ARGUMENTS');
      const requestId = input.request_id;
      tick();
      const initial = await auth(context, requestId);
      const checkpoint = async () => { const current = await auth(context, requestId); demand(equalPrincipal(initial.principal, current.principal) && initial.expiresAtMs === current.expiresAtMs, 'STALE_AUTHORIZATION'); };
      const reference = structuredClone(await resolveRequest(freeze({ principal: initial.principal, requestId })));
      await checkpoint();
      demand(validReference(reference) && reference.requestId === requestId && equalPrincipal(reference.principal, initial.principal), 'REQUEST_SCOPE_MISMATCH');
      freeze(reference);
      const evidence = structuredClone(await readEvidence(reference));
      await checkpoint();
      const connection = structuredClone(await readConnection(reference));
      await checkpoint();
      const record = structuredClone(await readJournalStatus(freeze({ tenantId: initial.principal.tenantId, subject: initial.principal.subject, requestId })));
      const journalReadAtMs = tick();
      await checkpoint();
      const observedAtMs = tick();
      demand(observedAtMs < initial.expiresAtMs, 'AUTHORIZATION_REJECTED');
      return projectJournalStatus({ record, reference, evidence, connection, observedAtMs, journalReadAtMs });
    } catch (error) {
      throw error instanceof GatewayStatusError ? error : new GatewayStatusError('STATUS_DEPENDENCY_UNAVAILABLE');
    }
  };
  return Object.freeze({ status: () => ({ configured: true, networkStarted: false }), read });
}

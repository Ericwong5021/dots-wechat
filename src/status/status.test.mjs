import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openJournal } from '../journal/journal.mjs';
import { createGatewayStatusReader, projectJournalStatus, gatewayStatusTool, gatewayStatusOutputSchema, GatewayStatusError } from './status.mjs';

const epoch = 1790812800000;
const principal = () => ({ tenantId: 'synthetic:tenant:a', subject: 'synthetic:owner:a', grantId: 'synthetic:grant:a', bindingId: 'synthetic:binding:a', watchId: 'synthetic:channel:a', generation: 1, revision: 1 });
const reference = () => ({ principal: principal(), requestId: 'synthetic:request:a', messageId: 'synthetic:message:a', eventId: 'synthetic:event:a', subscriptionId: 'synthetic:subscription:a', receivedAtMs: epoch });
const record = () => ({ requestId: 'synthetic:request:a', messageId: 'synthetic:message:a', eventId: 'synthetic:event:a', subscriptionId: 'synthetic:subscription:a', generation: 1, authorizationRevision: 1, uplink: 'READY', downlink: 'AWAITING_REPLY', cancelled: false, dispatchAttemptId: null, deliveryAttemptId: null, replyId: null, payloadPresent: true, payloadExpiresAt: epoch + 600000, tombstoneUntil: epoch + 86400000, retryAutomatically: false, personalDot: 'not_connected' });
const attempted = () => ({ ...record(), uplink: 'ACCEPTED', downlink: 'OUTCOME_UNKNOWN', dispatchAttemptId: 'synthetic:dispatch:a', deliveryAttemptId: 'synthetic:delivery:a', replyId: 'synthetic:reply:a' });
const evidence = () => ({ ...reference(), replyId: 'synthetic:reply:a', deliveryAttemptId: 'synthetic:delivery:a', kind: 'USER_VISIBLE_CONFIRMATION', observedAtMs: epoch + 10 });
const confirmation = () => { const result = evidence(); delete result.receivedAtMs; return result; };
const code = value => error => error instanceof GatewayStatusError && error.code === value && error.retryAutomatically === false;
const project = (row = record(), options = {}) => projectJournalStatus({ record: row, reference: reference(), observedAtMs: epoch + 100, ...options });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  const f = { now: epoch + 100, owner: principal(), expiresAtMs: epoch + 3600000, row: record(), reference: reference(), evidence: [], connection: null, queries: [], purposes: [] };
  f.reader = createGatewayStatusReader({
    authorize: async (_context, operation) => { f.purposes.push(operation); return { principal: f.owner, expiresAtMs: f.expiresAtMs }; },
    resolveRequest: async value => { f.queries.push(value); return f.reference; },
    readJournalStatus: async query => { f.queries.push(query); return f.row; },
    readEvidence: async () => f.evidence,
    readConnection: async () => f.connection,
    clock: () => f.now,
    ...overrides,
  });
  f.read = () => f.reader.read({ request_id: f.reference.requestId }, Object.freeze({ synthetic: true }));
  return f;
}

test('default reader is inert and schema cannot select another principal or enable network', async () => {
  const reader = createGatewayStatusReader();
  assert.deepEqual(reader.status(), { configured: false, networkStarted: false });
  await assert.rejects(reader.read({ request_id: 'synthetic:request:a' }), code('STATUS_READER_NOT_CONFIGURED'));
  assert.equal(gatewayStatusTool.name, 'weixin.get_message_status');
  assert.deepEqual(Object.keys(gatewayStatusTool.inputSchema.properties), ['request_id']);
  assert.equal(gatewayStatusTool.inputSchema.additionalProperties, false);
  assert.equal(gatewayStatusOutputSchema.additionalProperties, false);
  assert.throws(() => { gatewayStatusTool.name = 'changed'; }, TypeError);
});

test('received means gateway queued; no dot state and no invented transition time', () => {
  const result = project();
  assert.equal(result.state, 'RECEIVED');
  assert.equal(result.reason, 'QUEUED_IN_GATEWAY');
  assert.equal(result.receivedAtMs, epoch);
  assert.equal(result.stateChangedAtMs, null);
  assert.equal(result.observedAtMs, epoch + 100);
  assert.deepEqual(result.dot, { internalState: 'NOT_EXPOSED', existingDotBinding: 'NOT_VERIFIED_BY_THIS_MODULE' });
  assert.equal(result.connection.state, 'UNKNOWN');
  assert.equal(project(record(), { reference: { ...reference(), receivedAtMs: null } }).receivedAtMs, null);
});

test('upstream 2xx acceptance maps to processing, never dot completion', () => {
  const result = project({ ...record(), uplink: 'ACCEPTED', dispatchAttemptId: 'synthetic:dispatch:a' });
  assert.equal(result.state, 'PROCESSING');
  assert.equal(result.reason, 'EVENT_ACCEPTED_NOT_DOT_STATE');
  assert.equal(result.completionEvidence, null);
});

test('a correlated queued reply advances the gateway phase but preserves earlier unknown', () => {
  const result = project({ ...attempted(), uplink: 'OUTCOME_UNKNOWN', downlink: 'QUEUED', deliveryAttemptId: null });
  assert.equal(result.state, 'PROCESSING');
  assert.equal(result.reason, 'REPLY_QUEUED_BY_GATEWAY');
  assert.equal(result.hasUnknownOutcome, true);
  assert.equal(result.retryAutomatically, false);
});

test('journal receipt used by WeChat relay is not user-visible delivery', () => {
  const result = project({ ...attempted(), downlink: 'RECEIPT_RECORDED' });
  assert.equal(result.state, 'WAITING_CONFIRMATION');
  assert.equal(result.reason, 'RECEIPT_SEMANTICS_NOT_USER_DELIVERY');
  assert.equal(result.completionEvidence, null);
});

test('explicit owner confirmation is separate and never rewrites unknown journal outcome', () => {
  const row = attempted();
  const result = project(row, { evidence: [confirmation()] });
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.stateChangedAtMs, epoch + 10);
  assert.equal(result.journal.downlink, 'OUTCOME_UNKNOWN');
  assert.equal(row.downlink, 'OUTCOME_UNKNOWN');
  assert.equal(result.hasUnknownOutcome, true);
  assert.equal(result.retryAutomatically, false);
});

test('cancelled unknown is not resurrected by a late human confirmation', () => {
  const result = project({ ...attempted(), cancelled: true }, { evidence: [confirmation()] });
  assert.equal(result.state, 'WAITING_CONFIRMATION');
  assert.equal(result.reason, 'OUTCOME_UNKNOWN');
  assert.equal(result.journal.cancelled, true);
  assert.equal(result.completionEvidence.kind, 'USER_VISIBLE_CONFIRMATION');
  assert.equal(result.stateChangedAtMs, null);
});

test('cancelled recorded receipt remains cancelled when confirmation order is unknown', () => {
  const result = project({ ...attempted(), cancelled: true, downlink: 'RECEIPT_RECORDED' }, { evidence: [confirmation()] });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.reason, 'CANCELLED');
  assert.equal(result.completionEvidence.kind, 'USER_VISIBLE_CONFIRMATION');
});

test('device acknowledgment requires the exact trusted attempt, not API_ACCEPTED', () => {
  assert.equal(project(attempted(), { evidence: [{ ...confirmation(), kind: 'DEVICE_RECEIPT' }] }).state, 'COMPLETED');
  assert.throws(() => project(attempted(), { evidence: [{ ...confirmation(), kind: 'API_ACCEPTED' }] }), code('UNSUPPORTED_CONFIRMATION'));
  assert.throws(() => project(attempted(), { evidence: [{ ...confirmation(), deliveryAttemptId: 'synthetic:delivery:other' }] }), code('EVIDENCE_SCOPE_MISMATCH'));
});

test('expiry never converts an attempted unknown into safe failure or replay', () => {
  for (const row of [attempted(), { ...record(), uplink: 'OUTCOME_UNKNOWN', dispatchAttemptId: 'synthetic:dispatch:a' }, { ...attempted(), uplink: 'OUTCOME_UNKNOWN', downlink: 'QUEUED', deliveryAttemptId: null }]) {
    const result = project(row, { observedAtMs: epoch + 600000 });
    assert.equal(result.state, 'WAITING_CONFIRMATION');
    assert.equal(result.reason, 'OUTCOME_UNKNOWN');
    assert.equal(result.expired, true);
    assert.equal(result.retryAutomatically, false);
  }
});

test('no-effect expiry and explicit rejection keep distinct reasons', () => {
  assert.equal(project(record(), { observedAtMs: epoch + 600000 }).reason, 'PAYLOAD_EXPIRED');
  assert.equal(project({ ...record(), uplink: 'REJECTED', downlink: 'CANCELLED', dispatchAttemptId: 'synthetic:dispatch:a' }).reason, 'UPSTREAM_REJECTED');
  assert.throws(() => project(record(), { observedAtMs: epoch + 86400000 }), code('STATUS_RETENTION_EXPIRED'));
});

test('transport freshness is component-specific and never implies dot online', () => {
  const connection = { principal: principal(), component: 'wechat', state: 'AVAILABLE', observedAtMs: epoch, freshUntilMs: epoch + 1000 };
  const fresh = project(record(), { connection });
  assert.equal(fresh.connection.state, 'AVAILABLE');
  assert.equal(fresh.dot.internalState, 'NOT_EXPOSED');
  const stale = project(record(), { connection, observedAtMs: epoch + 1000 });
  assert.equal(stale.connection.state, 'UNKNOWN');
  assert.equal(stale.connection.source, 'STALE_TRANSPORT_OBSERVATION');
  assert.throws(() => project(record(), { connection: { ...connection, freshUntilMs: epoch + 60001 } }), code('INVALID_CONNECTION_TIME'));
});

test('cross-owner and stale-generation observations cannot be projected', () => {
  for (const key of ['tenantId', 'subject', 'grantId', 'bindingId', 'watchId']) {
    assert.throws(() => project(attempted(), { evidence: [{ ...confirmation(), principal: { ...principal(), [key]: 'synthetic:other' } }] }), code('EVIDENCE_SCOPE_MISMATCH'));
  }
  assert.throws(() => project({ ...record(), generation: 2 }), code('STALE_GENERATION_OR_REVISION'));
  assert.throws(() => project({ ...record(), authorizationRevision: 2 }), code('STALE_GENERATION_OR_REVISION'));
  for (const key of ['requestId', 'messageId', 'eventId', 'subscriptionId']) assert.throws(() => project({ ...record(), [key]: 'synthetic:other' }), code('CORRELATION_MISMATCH'));
});

test('future or pre-request evidence is rejected without echoing its content', () => {
  for (const observedAtMs of [epoch - 1, epoch + 101]) assert.throws(() => project(attempted(), { evidence: [{ ...confirmation(), observedAtMs }] }), code('INVALID_EVIDENCE_TIME'));
  assert.throws(() => project(record(), { observedAtMs: epoch - 1 }), code('INVALID_RECORD_TIME'));
});

test('output filters journal payloads and remains deeply immutable', () => {
  const result = project({ ...record(), text: 'synthetic-secret', contextToken: 'synthetic-context' });
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('synthetic-secret'), false);
  assert.equal(encoded.includes('synthetic-context'), false);
  assert.equal(encoded.includes('synthetic:owner'), false);
  assert.throws(() => { result.dot.internalState = 'thinking'; }, TypeError);
  assert.throws(() => { result.journal.uplink = 'ACCEPTED'; }, TypeError);
});

test('reader supplies owner selectors from the authorizer and rejects client owner selectors', async () => {
  const f = fixture();
  const result = await f.read();
  assert.equal(result.state, 'RECEIVED');
  assert.deepEqual(f.queries[1], { tenantId: f.owner.tenantId, subject: f.owner.subject, requestId: f.reference.requestId });
  assert.ok(f.purposes.every(value => value.purpose === 'gateway.status.read'));
  await assert.rejects(f.reader.read({ request_id: f.reference.requestId, subject: 'synthetic:other' }, {}), code('INVALID_STATUS_ARGUMENTS'));
});

test('same request ID cannot be resolved from another owner or binding', async () => {
  for (const field of ['tenantId', 'subject', 'bindingId', 'watchId']) {
    const f = fixture();
    f.reference.principal[field] = 'synthetic:other';
    await assert.rejects(f.read(), code('REQUEST_SCOPE_MISMATCH'));
  }
});

for (const dependency of ['resolveRequest', 'readJournalStatus', 'readEvidence', 'readConnection']) {
  test(`generation revocation during ${dependency} discards the late result`, async () => {
    const started = deferred(), completion = deferred();
    const values = { resolveRequest: reference(), readJournalStatus: record(), readEvidence: [], readConnection: null };
    const f = fixture({ [dependency]: async () => { started.resolve(); await completion.promise; return values[dependency]; } });
    const pending = f.read();
    await started.promise;
    f.owner.generation = 2;
    f.owner.revision = 2;
    completion.resolve();
    await assert.rejects(pending, code('STALE_AUTHORIZATION'));
  });
}

test('expired authorization after await returns no projected status', async () => {
  const started = deferred(), completion = deferred();
  const f = fixture({ readEvidence: async () => { started.resolve(); await completion.promise; return []; } });
  const pending = f.read();
  await started.promise;
  f.now = f.expiresAtMs;
  completion.resolve();
  await assert.rejects(pending, code('AUTHORIZATION_REJECTED'));
});

test('authorization expiring between final checkpoint and projection is rejected', async () => {
  let ticks = 0;
  const f = fixture({ clock: () => ++ticks < 8 ? epoch + 3599999 : epoch + 3600000 });
  await assert.rejects(f.read(), code('AUTHORIZATION_REJECTED'));
  assert.equal(ticks, 8);
});

for (const dependency of ['readEvidence', 'readConnection']) test(`request cancellation during ${dependency} is observed before projection`, async () => {
  const started = deferred(), completion = deferred();
  const f = fixture({ [dependency]: async () => { started.resolve(); await completion.promise; return dependency === 'readEvidence' ? [confirmation()] : null; } });
  f.row = { ...attempted(), downlink: 'RECEIPT_RECORDED' };
  f.evidence = [confirmation()];
  const pending = f.read();
  await started.promise;
  f.row.cancelled = true;
  completion.resolve();
  const result = await pending;
  assert.equal(result.state, 'FAILED');
  assert.equal(result.reason, 'CANCELLED');
  assert.equal(result.completionEvidence.kind, 'USER_VISIBLE_CONFIRMATION');
});

test('status read permission withdrawn at the final authorization checkpoint returns no data', async () => {
  let authorizations = 0;
  const f = fixture({ authorize: async (_context, operation) => {
    assert.equal(operation.purpose, 'gateway.status.read');
    if (++authorizations === 5) throw new Error('STATUS_READ_SCOPE_WITHDRAWN');
    return { principal: principal(), expiresAtMs: epoch + 3600000 };
  } });
  await assert.rejects(f.read(), code('AUTHORIZATION_REJECTED'));
  assert.equal(authorizations, 5);
});

test('a projection exposes snapshot time separately from final response time', async () => {
  let now = epoch;
  const f = fixture({ clock: () => ++now });
  const result = await f.read();
  assert.ok(result.journalReadAtMs < result.observedAtMs);
  assert.throws(() => project(record(), { journalReadAtMs: epoch + 101 }), code('INVALID_SNAPSHOT_TIME'));
});

test('renewing a deadline midway through a query requires a fresh query', async () => {
  const started = deferred(), completion = deferred();
  const f = fixture({ readEvidence: async () => { started.resolve(); await completion.promise; return []; } });
  const pending = f.read();
  await started.promise;
  f.expiresAtMs += 1;
  completion.resolve();
  await assert.rejects(pending, code('STALE_AUTHORIZATION'));
});

test('reader rejects clock rollback and masks dependent exceptions', async () => {
  const f = fixture();
  await f.read();
  f.now -= 1;
  await assert.rejects(f.read(), code('CLOCK_MOVED_BACKWARDS'));
  const broken = fixture({ readJournalStatus: async () => { throw new Error('synthetic-credential-never-echo'); } });
  await assert.rejects(broken.read(), code('STATUS_DEPENDENCY_UNAVAILABLE'));
});

test('actual journal statuses project without state-machine changes; reads may advance CAS revision', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dots-status-synthetic-'));
  let now = epoch;
  const journal = await openJournal({ directory: path.join(directory, 'journal'), key: Buffer.alloc(32, 0x53), mode: 'create', clock: () => now });
  t.after(async () => { await journal.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = principal(), ref = reference();
  const mutate = async (method, input) => journal[method]({ principal: owner, ...input, expectedRevision: (await journal.inspect()).commitRevision });
  await mutate('bind', { expiresAt: now + 3600000 });
  const message = Object.fromEntries(['requestId', 'messageId', 'eventId', 'subscriptionId'].map(key => [key, ref[key]]));
  await mutate('enqueue', { ...message, text: '[SYNTHETIC] local status fixture' });
  const reader = createGatewayStatusReader({ authorize: async () => ({ principal: owner, expiresAtMs: epoch + 3600000 }), resolveRequest: async () => ref, readJournalStatus: journal.readStatus, clock: () => now });
  const read = () => reader.read({ request_id: ref.requestId }, {});
  assert.equal((await read()).state, 'RECEIVED');
  const before = (await journal.inspect()).commitRevision;
  now += 1;
  await read();
  assert.ok((await journal.inspect()).commitRevision > before);
  const claimed = await mutate('claimDispatch', { requestId: ref.requestId });
  assert.equal((await read()).reason, 'OUTCOME_UNKNOWN');
  await mutate('recordDispatch', { requestId: ref.requestId, attemptId: claimed.dispatchAttemptId, outcome: 'ACCEPTED' });
  assert.equal((await read()).state, 'PROCESSING');
  await mutate('queueReply', { ...message, replyId: 'synthetic:reply:a', text: '[SYNTHETIC] reply fixture' });
  const reply = await mutate('claimReply', { requestId: ref.requestId });
  assert.equal((await read()).state, 'WAITING_CONFIRMATION');
  await mutate('recordReceipt', { requestId: ref.requestId, replyId: reply.replyId, attemptId: reply.deliveryAttemptId });
  assert.equal((await read()).reason, 'RECEIPT_SEMANTICS_NOT_USER_DELIVERY');
  assert.equal((await journal.readStatus({ tenantId: owner.tenantId, subject: owner.subject, requestId: ref.requestId })).payloadPresent, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLoopbackBackend, backendCatalog, restrictedTestContract } from './backend.mjs';
import { openJournal } from '../journal/journal.mjs';
import { WEIXIN_TEXT_LIMITS } from '../weixin/client.mjs';

const principal = Object.freeze({ tenantId: 'synthetic-tenant', subject: 'synthetic-owner', grantId: 'synthetic-grant', bindingId: 'synthetic-binding', watchId: 'synthetic-watch', generation: 1, revision: 1 });
const params = ttlMs => ({ name: 'weixin.owner_message', arguments: { binding_id: principal.bindingId, generation: 1 }, delivery: { mode: 'webhook', url: 'https://synthetic.example.test/events', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` }, ttlMs });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dots-restricted-synthetic-'));
  let time = 100000, active = true, leaseChecks = 0, verificationCalls = 0, pollCalls = 0, publishCalls = 0, sendCalls = 0;
  const clock = () => time;
  const key = Buffer.alloc(32, 9);
  const journal = await openJournal({ directory: path.join(directory, 'journal'), key, mode: 'create', clock });
  await journal.bind({ principal, expiresAt: 3700000, expectedRevision: 0 });
  const context = Object.freeze({ syntheticProof: 'not-an-external-token' });
  const events = [];
  const operationLease = Object.freeze({ expiresAtMs: overrides.deadline ?? 1900000, check: () => { leaseChecks++; return overrides.check ? overrides.check() : active; } });
  const restrictedAuthorization = Object.freeze({ issuer: 'https://issuer.example.test/synthetic', audience: 'synthetic-mcp', verify: async (candidate, detail, options) => {
    verificationCalls++;
    assert.equal(candidate, context);
    assert.equal(options.operationLease, operationLease);
    const evidence = { principal: { ...principal }, expiresAtMs: detail.authorization.expiresAtMs, purpose: detail.purpose, requestId: detail.requestId, checkedAtMs: time, issuer: restrictedAuthorization.issuer, audience: restrictedAuthorization.audience, credentialId: 'synthetic-credential-not-real' };
    return overrides.verifyAuthorization ? overrides.verifyAuthorization(evidence, detail) : evidence;
  } });
  const options = {
    mode: 'restricted-test', journal: { ...journal, inspect: async () => { const value = await journal.inspect(); await overrides.inspect?.(); return value; }, readStatus: async input => {
      let value, failure;
      try { value = await journal.readStatus(input); } catch (error) { failure = error; }
      await overrides.readStatus?.({ value, failure, input });
      if (failure) throw failure;
      return value;
    } }, correlationKey: key, clock, operationLease, restrictedAuthorization,
    authorize: async () => overrides.authorize ? overrides.authorize() : { principal: { ...principal }, expiresAtMs: 3700000 },
    verifySubscription: async (candidate, transport) => { assert.equal(transport.operationLease, operationLease); return overrides.verifySubscription ? overrides.verifySubscription(candidate) : { verified: true }; },
    publishEvent: async (event, sub, transport) => { publishCalls++; assert.equal(transport.operationLease, operationLease); events.push(event); return overrides.publish ? overrides.publish(event) : { outcome: 'ACCEPTED' }; },
    weixin: {
      getUpdates: async transport => { pollCalls++; assert.equal(transport.operationLease, operationLease); return overrides.poll ? overrides.poll() : { status: 'OK', messages: [{ messageId: 'synthetic-inbound', text: 'synthetic owner text' }] }; },
      pendingMessages: async transport => { pollCalls++; assert.equal(transport.operationLease, operationLease); return overrides.pending ? overrides.pending() : { status: 'OK', messages: [] }; },
      sendText: async (args, transport) => { sendCalls++; assert.equal(transport.operationLease, operationLease); return overrides.send ? overrides.send(args) : { status: 'API_ACCEPTED' }; },
    },
  };
  const backends = [];
  const create = extra => { const backend = createLoopbackBackend({ ...options, ...extra }); backends.push(backend); return backend; };
  t.after(async () => { for (const backend of backends) await backend.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  return { create, options, journal, context, events, setTime: value => { time = value; }, revoke: () => { active = false; }, activate: () => { active = true; }, counts: () => ({ leaseChecks, verificationCalls, pollCalls, publishCalls, sendCalls }) };
}

async function receive(f, backend) { await backend.subscribe(params(600000), f.context); return backend.pollOwner(f.context); }
const reply = f => ({ ...f.events[0].data, reply_id: 'synthetic-reply', text: 'synthetic reply text' });
const record = (f, event = f.events[0]) => f.journal.readStatus({ tenantId: principal.tenantId, subject: principal.subject, requestId: event.data.request_id });

test('restricted mode is source-only opt-in and default catalog stays local and disabled', async () => {
  const backend = createLoopbackBackend();
  assert.equal(backend.status().mode, 'disabled');
  assert.equal(backend.status().liveEnabled, false);
  assert.equal(backend.catalog, backendCatalog);
  assert.equal(restrictedTestContract.maximumLeaseMs, 1800000);
  assert.deepEqual(WEIXIN_TEXT_LIMITS, { providerBatchMessages: 128, retainedMessages: 1024 });
  await backend.close();
});

test('restricted factory rejects missing, mutable, getter, nonfinite and extended operation leases', async t => {
  const f = await fixture(t);
  const getter = {}; Object.defineProperties(getter, { expiresAtMs: { get: () => 1900000, enumerable: true }, check: { value: () => true, enumerable: true } }); Object.freeze(getter);
  for (const operationLease of [undefined, { expiresAtMs: 1900000, check: () => true }, getter, Object.freeze({ expiresAtMs: Infinity, check: () => true }), Object.freeze({ expiresAtMs: 1900001, check: () => true }), Object.freeze({ expiresAtMs: 100000, check: () => true })]) {
    assert.throws(() => f.create({ operationLease }), { code: 'OPERATION_LEASE_REQUIRED' });
  }
  assert.equal(f.counts().pollCalls, 0);
});

test('mode and old authorize/verified booleans cannot replace a configured external authorization verifier', async t => {
  const f = await fixture(t);
  for (const restrictedAuthorization of [undefined, { issuer: 'synthetic', audience: 'synthetic', verify: async () => ({ verified: true }) }, Object.freeze({ verified: true })]) {
    assert.throws(() => f.create({ restrictedAuthorization }), { code: 'EXTERNAL_AUTHORIZATION_VERIFIER_REQUIRED' });
  }
  const backend = f.create({ restrictedAuthorization: Object.freeze({ issuer: 'synthetic', audience: 'synthetic', verify: async () => ({ verified: true }) }) });
  await assert.rejects(backend.subscribe(params(600000), f.context), { code: 'EXTERNAL_AUTHORIZATION_REJECTED' });
  assert.equal(f.counts().pollCalls, 0);
});

test('configuration metadata and schemas distinguish restricted adapters without claiming identity or delivery', async t => {
  const f = await fixture(t), backend = f.create();
  const received = await receive(f, backend);
  assert.equal(backend.status().evidenceMode, 'CONFIGURED_RESTRICTED_LIVE_TRANSPORT');
  assert.equal(backend.status().existingDot, 'not_verified');
  assert.equal(backend.catalog.tools[0].outputSchema.properties.liveEnabled.const, true);
  assert.equal(backendCatalog.tools[0].outputSchema.properties.liveEnabled.const, false);
  assert.equal(received.messages[0].evidenceMode, 'CONFIGURED_RESTRICTED_LIVE_TRANSPORT');
  const sent = await backend.callTool('weixin.deliver_owner_reply', reply(f), f.context);
  assert.equal(sent.code, 'WEIXIN_API_ACCEPTED');
  assert.equal(sent.deliveryConfirmed, false);
  assert.equal(sent.existingDot, 'not_verified');
  assert.equal(sent.retryAutomatically, false);
  const status = await backend.callTool('weixin.get_message_status', { request_id: sent.request_id }, f.context);
  assert.equal(status.state, 'WAITING_CONFIRMATION');
  assert.equal(status.dot.existingDotBinding, 'NOT_VERIFIED_BY_THIS_MODULE');
  assert.ok(f.counts().verificationCalls > 10);
});

test('subscription refresh and null or excessive TTL never outlive the fixed lease', async t => {
  const f = await fixture(t, { deadline: 250000 }), backend = f.create();
  const first = await backend.subscribe(params(null), f.context);
  assert.equal(first.expiresAtMs, 250000);
  f.setTime(240000);
  const refreshed = await backend.subscribe(params(Number.MAX_SAFE_INTEGER), f.context);
  assert.equal(refreshed.subscriptionId, first.subscriptionId);
  assert.equal(refreshed.expiresAtMs, 250000);
  assert.equal(backend.status().operationLeaseExpiresAtMs, 250000);
  f.setTime(250000);
  await assert.rejects(backend.pollOwner(f.context), { code: 'OPERATION_LEASE_EXPIRED' });
  assert.equal(backend.status().liveEnabled, false);
  assert.equal(f.counts().pollCalls, 0);
});

test('explicit restricted TTL covers the remaining thirty-minute lease while the default remains ten minutes', async t => {
  const f = await fixture(t), backend = f.create();
  const initial = await backend.subscribe(params(undefined), f.context);
  assert.equal(initial.expiresAtMs, 700000);
  const requested = await backend.subscribe(params(1800000), f.context);
  assert.equal(requested.expiresAtMs, 1900000);
  assert.equal(requested.subscriptionId, initial.subscriptionId);
  f.setTime(200000);
  const excessive = await backend.subscribe(params(Number.MAX_SAFE_INTEGER), f.context);
  assert.equal(excessive.expiresAtMs, 1900000);
  assert.equal(backend.status().operationLeaseExpiresAtMs, 1900000);
});

test('revocation is latched and cannot reactivate from a later true check', async t => {
  const f = await fixture(t), backend = f.create();
  f.revoke();
  await assert.rejects(backend.subscribe(params(600000), f.context), { code: 'OPERATION_LEASE_REVOKED' });
  f.activate();
  await assert.rejects(backend.subscribe(params(600000), f.context), { code: 'OPERATION_LEASE_REVOKED' });
  assert.equal(backend.status().operationLeaseActive, false);
  assert.equal(f.counts().verificationCalls, 0);
});

test('asynchronous lease checks and external exceptions fail closed without leaking errors', async t => {
  for (const [check, code] of [[async () => true, 'OPERATION_LEASE_CHECK_NOT_SYNCHRONOUS'], [() => { throw new Error('synthetic-secret'); }, 'OPERATION_LEASE_REVOKED']]) {
    const f = await fixture(t, { check }), backend = f.create();
    await assert.rejects(backend.subscribe(params(600000), f.context), error => error.code === code && !error.message.includes('synthetic-secret'));
    assert.equal(f.counts().verificationCalls, 0);
  }
});

test('scope, request, issuer, audience, principal, freshness and expiry must match actual authorization', async t => {
  for (const change of [value => { value.purpose = 'weixin.message.deliver'; }, value => { value.requestId = 'wrong'; }, value => { value.issuer = 'https://other.example.test'; }, value => { value.audience = 'wrong'; }, value => { value.principal.subject = 'other'; }, value => { value.checkedAtMs--; }, value => { value.expiresAtMs--; }, value => { value.credentialId = ''; }, value => { value.extra = true; }]) {
    const f = await fixture(t, { verifyAuthorization: evidence => { change(evidence); return evidence; } }), backend = f.create();
    await assert.rejects(backend.subscribe(params(600000), f.context), { code: 'EXTERNAL_AUTHORIZATION_REJECTED' });
    assert.equal(f.counts().pollCalls, 0);
  }
});

test('lease expiry while authorize or external verifier awaits cannot activate a subscription', async t => {
  for (const dependency of ['authorize', 'verifyAuthorization']) {
    const entered = deferred(), finish = deferred();
    const overrides = { deadline: 250000, [dependency]: async value => { entered.resolve(); await finish.promise; return value ?? { principal: { ...principal }, expiresAtMs: 3700000 }; } };
    const f = await fixture(t, overrides), backend = f.create();
    const activation = backend.subscribe(params(600000), f.context);
    await entered.promise; f.setTime(250000); finish.resolve();
    await assert.rejects(activation, { code: 'OPERATION_LEASE_EXPIRED' });
    assert.equal(f.counts().pollCalls, 0);
  }
});

test('verification callback finishing after lease deadline cannot activate a subscription', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { deadline: 250000, verifySubscription: async () => { entered.resolve(); await finish.promise; return { verified: true }; } }), backend = f.create();
  const activation = backend.subscribe(params(600000), f.context);
  await entered.promise; f.setTime(250000); finish.resolve();
  await assert.rejects(activation, { code: 'OPERATION_LEASE_EXPIRED' });
  assert.equal(f.counts().pollCalls, 0);
});

test('revocation during ingress read stops before event claim or publication', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { poll: async () => { entered.resolve(); await finish.promise; return { status: 'OK', messages: [{ messageId: 'synthetic-inbound', text: 'synthetic text' }] }; } }), backend = f.create();
  await backend.subscribe(params(600000), f.context);
  const polling = backend.pollOwner(f.context);
  await entered.promise; f.revoke(); finish.resolve();
  await assert.rejects(polling, { code: 'OPERATION_LEASE_REVOKED' });
  assert.equal(f.counts().publishCalls, 0);
});

test('event acceptance arriving after revocation stays journal UNKNOWN and no automatic replay occurs', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { publish: async () => { entered.resolve(); await finish.promise; return { outcome: 'ACCEPTED' }; } }), backend = f.create();
  await backend.subscribe(params(600000), f.context);
  const polling = backend.pollOwner(f.context);
  await entered.promise; f.revoke(); finish.resolve();
  await assert.rejects(polling, { code: 'OPERATION_LEASE_REVOKED', outcome: 'OUTCOME_UNKNOWN', retryAutomatically: false });
  assert.equal((await record(f)).uplink, 'OUTCOME_UNKNOWN');
  f.activate();
  await assert.rejects(backend.pollOwner(f.context), { code: 'OPERATION_LEASE_REVOKED' });
  assert.equal(f.counts().publishCalls, 1);
});

test('send acceptance arriving at the fixed deadline stays UNKNOWN and cannot become a success', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { deadline: 250000, send: async () => { entered.resolve(); await finish.promise; return { status: 'API_ACCEPTED' }; } }), backend = f.create();
  await receive(f, backend);
  const sending = backend.callTool('weixin.deliver_owner_reply', reply(f), f.context);
  await entered.promise; f.setTime(250000); finish.resolve();
  await assert.rejects(sending, { code: 'OPERATION_LEASE_EXPIRED', outcome: 'OUTCOME_UNKNOWN', retryAutomatically: false });
  assert.equal((await record(f)).downlink, 'OUTCOME_UNKNOWN');
  await assert.rejects(backend.callTool('weixin.deliver_owner_reply', reply(f), f.context), { code: 'OPERATION_LEASE_EXPIRED' });
  assert.equal(f.counts().sendCalls, 1);
});

test('ordinary restricted send uncertainty never permits duplicate transport', async t => {
  const f = await fixture(t, { send: async () => { throw new Error('synthetic timeout'); } }), backend = f.create();
  await receive(f, backend);
  for (let index = 0; index < 2; index++) assert.equal((await backend.callTool('weixin.deliver_owner_reply', reply(f), f.context)).code, 'WEIXIN_SEND_OUTCOME_UNKNOWN');
  assert.equal(f.counts().sendCalls, 1);
});

test('revocation during journal inspection prevents the subsequent mutation and send', async t => {
  let revokeNext = false;
  const f = await fixture(t, { inspect: () => { if (revokeNext) f.revoke(); } }), backend = f.create();
  await receive(f, backend);
  revokeNext = true;
  await assert.rejects(backend.callTool('weixin.deliver_owner_reply', reply(f), f.context), { code: 'OPERATION_LEASE_REVOKED' });
  assert.equal(f.counts().sendCalls, 0);
});

test('a status dependency finishing after revocation cannot return previously collected success evidence', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t), backend = f.create({ readEvidence: async () => { entered.resolve(); await finish.promise; return []; } });
  await receive(f, backend);
  await backend.callTool('weixin.deliver_owner_reply', reply(f), f.context);
  const reading = backend.callTool('weixin.get_message_status', { request_id: f.events[0].data.request_id }, f.context);
  await entered.promise; f.revoke(); finish.resolve();
  await assert.rejects(reading, { code: 'OPERATION_LEASE_REVOKED' });
});

test('external verifier rejection at a later checkpoint prevents all subsequent effects', async t => {
  let reject = false;
  const f = await fixture(t, { verifyAuthorization: evidence => { if (reject) throw new Error('synthetic invalidated credential'); return evidence; } }), backend = f.create();
  await receive(f, backend);
  reject = true;
  await assert.rejects(backend.callTool('weixin.deliver_owner_reply', reply(f), f.context), { code: 'EXTERNAL_AUTHORIZATION_REJECTED' });
  assert.equal(f.counts().sendCalls, 0);
});

test('an external lease check advancing the clock through deadline rejects immediately', async t => {
  let f;
  f = await fixture(t, { deadline: 250000, check: () => { f.setTime(250000); return true; } });
  const backend = f.create();
  await assert.rejects(backend.subscribe(params(600000), f.context), { code: 'OPERATION_LEASE_EXPIRED' });
  assert.equal(f.counts().verificationCalls, 0);
});

test('provider ingress uses the unchanged shared batch boundary before any publication', async t => {
  const f = await fixture(t, { poll: async () => ({ status: 'OK', messages: Array.from({ length: WEIXIN_TEXT_LIMITS.providerBatchMessages + 1 }, () => ({ messageId: 'synthetic-inbound', text: 'synthetic text' })) }) }), backend = f.create();
  await backend.subscribe(params(600000), f.context);
  await assert.rejects(backend.pollOwner(f.context), { code: 'WEIXIN_INGRESS_UNAVAILABLE' });
  assert.equal(f.counts().publishCalls, 0);
});

test('retained pending ingress uses its distinct shared boundary before publication', async t => {
  const f = await fixture(t, { pending: async () => ({ status: 'OK', messages: Array.from({ length: WEIXIN_TEXT_LIMITS.retainedMessages + 1 }, () => ({ messageId: 'synthetic-inbound', text: 'synthetic text' })) }) }), backend = f.create();
  await backend.subscribe(params(600000), f.context);
  await assert.rejects(backend.pollOwner(f.context, { pendingOnly: true }), { code: 'WEIXIN_INGRESS_UNAVAILABLE' });
  assert.equal(f.counts().publishCalls, 0);
});

for (const stage of [1, 2]) {
  test(`cancellation during reply journal inspection prevents ${stage === 1 ? 'queue' : 'claim'} commit`, async t => {
    const entered = deferred(), finish = deferred(), controller = new AbortController();
    let pause = false, replyInspections = 0;
    const f = await fixture(t, { inspect: async () => { if (pause && ++replyInspections === stage) { entered.resolve(); await finish.promise; } } }), backend = f.create();
    await receive(f, backend);
    pause = true;
    const sending = backend.callTool('weixin.deliver_owner_reply', reply(f), f.context, { signal: controller.signal });
    await entered.promise; controller.abort(); finish.resolve();
    await assert.rejects(sending, { code: 'OPERATION_CANCELLED' });
    assert.equal((await record(f)).downlink, stage === 1 ? 'AWAITING_REPLY' : 'QUEUED');
    assert.equal(f.counts().sendCalls, 0);
  });
}

test('credential revocation during prior status read prevents duplicate receipt under an active lease', async t => {
  const entered = deferred(), finish = deferred();
  let pause = false, authorized = true;
  const f = await fixture(t, { readStatus: async () => { if (pause) { entered.resolve(); await finish.promise; } }, verifyAuthorization: value => { if (!authorized) throw new Error('synthetic credential revoked'); return value; } }), backend = f.create();
  await receive(f, backend);
  pause = true;
  const polling = backend.pollOwner(f.context);
  await entered.promise; authorized = false; finish.resolve();
  await assert.rejects(polling, { code: 'EXTERNAL_AUTHORIZATION_REJECTED' });
  assert.equal(backend.status().operationLeaseActive, true);
  assert.equal(f.counts().publishCalls, 1);
});

test('credential revocation during missing status read prevents plaintext enqueue under an active lease', async t => {
  const entered = deferred(), finish = deferred();
  let authorized = true;
  const f = await fixture(t, { readStatus: async ({ failure }) => { assert.equal(failure?.code, 'REQUEST_NOT_FOUND'); entered.resolve(); await finish.promise; }, verifyAuthorization: value => { if (!authorized) throw new Error('synthetic credential revoked'); return value; } }), backend = f.create();
  await backend.subscribe(params(600000), f.context);
  const before = await f.journal.inspect();
  const polling = backend.pollOwner(f.context);
  await entered.promise; authorized = false; finish.resolve();
  await assert.rejects(polling, { code: 'EXTERNAL_AUTHORIZATION_REJECTED' });
  assert.equal((await f.journal.inspect()).commitRevision, before.commitRevision);
  assert.equal(backend.status().operationLeaseActive, true);
  assert.equal(f.counts().publishCalls, 0);
});

test('credential revocation during terminal reply lookup prevents a stale success receipt', async t => {
  const entered = deferred(), finish = deferred();
  let authorized = true;
  const f = await fixture(t, { verifyAuthorization: value => { if (!authorized) throw new Error('synthetic credential revoked'); return value; } }), backend = f.create();
  await receive(f, backend);
  await backend.callTool('weixin.deliver_owner_reply', reply(f), f.context);
  f.options.journal.queueReply = async (input, transport) => { assert.equal(transport.operationLease, f.options.operationLease); const value = await f.journal.queueReply(input); entered.resolve(); await finish.promise; return value; };
  const lookup = backend.callTool('weixin.deliver_owner_reply', reply(f), f.context);
  await entered.promise; authorized = false; finish.resolve();
  await assert.rejects(lookup, { code: 'EXTERNAL_AUTHORIZATION_REJECTED', outcome: 'OUTCOME_UNKNOWN', retryAutomatically: false });
  assert.equal(f.counts().sendCalls, 1);
});

test('credential revocation during send receipt journal completion cannot return API success', async t => {
  const entered = deferred(), finish = deferred();
  let authorized = true;
  const f = await fixture(t, { verifyAuthorization: value => { if (!authorized) throw new Error('synthetic credential revoked'); return value; } }), backend = f.create();
  await receive(f, backend);
  f.options.journal.recordReceipt = async (input, transport) => { assert.equal(transport.operationLease, f.options.operationLease); const value = await f.journal.recordReceipt(input); entered.resolve(); await finish.promise; return value; };
  const sending = backend.callTool('weixin.deliver_owner_reply', reply(f), f.context);
  await entered.promise; authorized = false; finish.resolve();
  await assert.rejects(sending, { code: 'EXTERNAL_AUTHORIZATION_REJECTED', outcome: 'OUTCOME_UNKNOWN', retryAutomatically: false });
  assert.equal(f.counts().sendCalls, 1);
});

test('credential revocation during event receipt journal completion cannot return callback success', async t => {
  const entered = deferred(), finish = deferred();
  let authorized = true;
  const f = await fixture(t, { verifyAuthorization: value => { if (!authorized) throw new Error('synthetic credential revoked'); return value; } }), backend = f.create();
  await backend.subscribe(params(600000), f.context);
  f.options.journal.recordDispatch = async (input, transport) => { assert.equal(transport.operationLease, f.options.operationLease); const value = await f.journal.recordDispatch(input); entered.resolve(); await finish.promise; return value; };
  const polling = backend.pollOwner(f.context);
  await entered.promise; authorized = false; finish.resolve();
  await assert.rejects(polling, { code: 'EXTERNAL_AUTHORIZATION_REJECTED', outcome: 'OUTCOME_UNKNOWN', retryAutomatically: false });
  assert.equal(f.counts().publishCalls, 1);
});

test('journal adapters receive the caller cancellation signal for every ingress and reply mutation', async t => {
  const controller = new AbortController(), calls = [];
  const f = await fixture(t);
  for (const method of ['enqueue', 'claimDispatch', 'recordDispatch', 'queueReply', 'claimReply', 'recordReceipt']) f.options.journal[method] = async (input, transport) => {
    assert.equal(transport.signal, controller.signal);
    assert.equal(transport.operationLease, f.options.operationLease);
    calls.push(method);
    return f.journal[method](input);
  };
  const backend = f.create();
  await backend.subscribe(params(600000), f.context, { signal: controller.signal });
  await backend.pollOwner(f.context, { signal: controller.signal });
  await backend.callTool('weixin.deliver_owner_reply', reply(f), f.context, { signal: controller.signal });
  assert.deepEqual(calls, ['enqueue', 'claimDispatch', 'recordDispatch', 'queueReply', 'claimReply', 'recordReceipt']);
});

test('credential revocation during enqueue inspection prevents plaintext commit', async t => {
  const entered = deferred(), finish = deferred();
  let authorized = true;
  const f = await fixture(t, { inspect: async () => { entered.resolve(); await finish.promise; }, verifyAuthorization: value => { if (!authorized) throw new Error('synthetic credential revoked'); return value; } }), backend = f.create();
  await backend.subscribe(params(600000), f.context);
  const before = await f.journal.inspect();
  const polling = backend.pollOwner(f.context);
  await entered.promise; authorized = false; finish.resolve();
  await assert.rejects(polling, { code: 'EXTERNAL_AUTHORIZATION_REJECTED' });
  assert.equal((await f.journal.inspect()).commitRevision, before.commitRevision);
  assert.equal(f.counts().publishCalls, 0);
});

test('credential revocation during reply queue inspection prevents reply commit', async t => {
  const entered = deferred(), finish = deferred();
  let authorized = true, pause = false;
  const f = await fixture(t, { inspect: async () => { if (pause) { entered.resolve(); await finish.promise; } }, verifyAuthorization: value => { if (!authorized) throw new Error('synthetic credential revoked'); return value; } }), backend = f.create();
  await receive(f, backend);
  pause = true;
  const sending = backend.callTool('weixin.deliver_owner_reply', reply(f), f.context);
  await entered.promise; authorized = false; finish.resolve();
  await assert.rejects(sending, { code: 'EXTERNAL_AUTHORIZATION_REJECTED' });
  assert.equal((await record(f)).downlink, 'AWAITING_REPLY');
  assert.equal(f.counts().sendCalls, 0);
});

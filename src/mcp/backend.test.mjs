import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLoopbackBackend, backendCatalog, loopbackOperationSchemas } from './backend.mjs';

import { openJournal } from '../journal/journal.mjs';
import { createWeixinTextClient } from '../weixin/client.mjs';
const principal = { tenantId: 'fixture-tenant', subject: 'fixture-owner', grantId: 'fixture-grant', bindingId: 'fixture-binding', watchId: 'fixture-watch', generation: 1, revision: 1 };
const params = () => ({ name: 'weixin.owner_message', arguments: { binding_id: principal.bindingId, generation: 1 }, delivery: { mode: 'webhook', url: 'https://callback.example.test/events', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` }, ttlMs: 600000 });
const removeParams = () => ({ name: 'weixin.owner_message', arguments: { binding_id: principal.bindingId, generation: 1 }, delivery: { mode: 'webhook', url: 'https://callback.example.test/events' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dots-mcp-backend-'));
  let time = 100000, allowed = true, scopes = null, generation = 1;
  const context = Object.freeze({ fixtureCapability: 'local-only' });
  const key = Buffer.alloc(32, 3), journalDirectory = path.join(directory, 'journal');
  const clock = () => time;
  const journal = await openJournal({ directory: journalDirectory, key, mode: 'create', clock });
  await journal.bind({ principal, expiresAt: 3700000, expectedRevision: 0 });
  let networkCalls = 0, sendCalls = 0, pollCalls = 0;
  const events = [], effects = [];
  const weixin = createWeixinTextClient({ enabled: true, botToken: 'fixture-token-not-real', botId: 'fixture-bot', ownerUserId: 'fixture-owner', now: clock, wallNow: clock, fetchImpl: async (url, request) => {
    networkCalls++;
    if (url.endsWith('/getupdates')) {
      pollCalls++;
      return new Response(JSON.stringify({ msgs: pollCalls === 1 ? [{ from_user_id: 'fixture-owner', to_user_id: 'fixture-bot', message_id: '12345', message_type: 1, message_state: 2, context_token: 'fixture-private-context', item_list: [{ type: 1, text_item: { text: 'synthetic owner message' } }] }] : [], get_updates_buf: `fixture-cursor-${pollCalls}` }), { status: 200 });
    }
    assert.ok(url.endsWith('/sendmessage'));
    sendCalls++;
    effects.push(JSON.parse(request.body).msg);
    if (overrides.send) return overrides.send();
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  } });
  const options = {
    mode: 'injected-local', journal, correlationKey: key, weixin, clock,
    authorize: async (candidate, { purpose }) => {
      assert.equal(candidate, context);
      if (!allowed || (scopes && !scopes.includes(purpose))) throw new Error('sensitive failure fixture-token-not-real');
      return { principal: { ...principal, generation }, expiresAtMs: 3700000 };
    },
    verifySubscription: overrides.verify ?? (async () => ({ verified: true })),
    publishEvent: async event => { events.push(event); return overrides.publish ? overrides.publish(event) : { outcome: 'ACCEPTED' }; },
  };
  const backend = createLoopbackBackend(options);
  t.after(async () => { await backend.close(); await weixin.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  return { backend, journal, context, events, effects, options, directory, key, journalDirectory, setTime: value => { time = value; }, setAllowed: value => { allowed = value; }, setScopes: value => { scopes = value; }, setGeneration: value => { generation = value; }, counts: () => ({ networkCalls, sendCalls, pollCalls }) };
}

const subscribed = async f => f.backend.subscribe(params(), f.context);
const receive = async f => { await subscribed(f); return f.backend.pollOwner(f.context); };
const reply = (f, extra = {}) => ({ ...f.events[0].data, reply_id: 'fixture-reply', text: 'synthetic dot response', ...extra });
const replyArgs = f => { const value = reply(f); return value; };

test('default backend exposes catalog and safe health only; protected calls deny', async () => {
  const backend = createLoopbackBackend();
  assert.equal(backendCatalog.tools.length, 2);
  assert.equal(backendCatalog.events[0].name, 'weixin.owner_message');
  assert.equal((await backend.readResource('dots-wechat://gateway/status')).liveEnabled, false);
  await assert.rejects(backend.callTool('weixin.get_message_status', { request_id: 'anything' }), { code: 'BACKEND_NOT_CONFIGURED' });
  await assert.rejects(backend.subscribe(params(), {}), { code: 'BACKEND_NOT_CONFIGURED' });
  assert.throws(() => createLoopbackBackend({ mode: 'live' }), { code: 'LIVE_MODE_NOT_IMPLEMENTED' });
});

test('actual Weixin client and encrypted journal compose one synthetic event and unique reply', async t => {
  const f = await fixture(t);
  const received = await receive(f);
  assert.equal(received.messages[0].code, 'MCP_EVENT_ACCEPTED');
  const request_id = received.messages[0].request_id;
  let status = await f.backend.callTool('weixin.get_message_status', { request_id }, f.context);
  assert.equal(status.state, 'PROCESSING');
  assert.equal(status.dot.internalState, 'NOT_EXPOSED');
  const sent = await f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context);
  assert.equal(sent.code, 'WEIXIN_API_ACCEPTED');
  assert.equal(sent.deliveryConfirmed, false);
  status = await f.backend.readResource(`dots-wechat://message/${encodeURIComponent(request_id)}/status`, f.context);
  assert.equal(status.state, 'WAITING_CONFIRMATION');
  assert.equal(status.reason, 'RECEIPT_SEMANTICS_NOT_USER_DELIVERY');
  assert.equal(f.effects[0].to_user_id, 'fixture-owner');
  assert.equal(f.effects[0].context_token, 'fixture-private-context');
  await f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context);
  assert.equal(f.counts().sendCalls, 1);
  assert.equal(JSON.stringify(status).includes('fixture-private-context'), false);
  assert.equal(JSON.stringify(received).includes('synthetic owner message'), false);
});

test('without a verified subscription no WeChat polling starts', async t => {
  const f = await fixture(t);
  await assert.rejects(f.backend.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
  assert.equal(f.counts().networkCalls, 0);
});

test('callback verification, binding mismatch and denied scope block activation', async t => {
  const f = await fixture(t, { verify: async () => ({ verified: false }) });
  await assert.rejects(subscribed(f), { code: 'CALLBACK_NOT_VERIFIED' });
  const wrong = params(); wrong.arguments.generation = 2;
  await assert.rejects(f.backend.subscribe(wrong, f.context), { code: 'BINDING_MISMATCH' });
  f.setScopes(['gateway.status.read']);
  await assert.rejects(subscribed(f), { code: 'AUTHORIZATION_REJECTED' });
  assert.equal(f.counts().networkCalls, 0);
});

test('expiry and generation change during verification cannot activate subscription', async t => {
  const wait = deferred();
  const entered = deferred();
  const f = await fixture(t, { verify: async () => { entered.resolve(); await wait.promise; return { verified: true }; } });
  const activation = subscribed(f);
  await entered.promise;
  f.setGeneration(2);
  wait.resolve();
  await assert.rejects(activation, { code: 'STALE_AUTHORIZATION' });
  f.setGeneration(1);
  await assert.rejects(f.backend.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
});

test('duplicate inbound capabilities do not replay events', async t => {
  const f = await fixture(t);
  await receive(f);
  const second = await f.backend.pollOwner(f.context, { pendingOnly: true });
  assert.equal(second.messages[0].code, 'DUPLICATE_NOT_REPLAYED');
  assert.equal(f.events.length, 1);
});

test('transport failure persists UNKNOWN and identical reply is never sent again', async t => {
  const f = await fixture(t, { send: async () => { throw new Error('fixture secret failure'); } });
  const received = await receive(f);
  assert.equal((await f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context)).code, 'WEIXIN_SEND_OUTCOME_UNKNOWN');
  assert.equal((await f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context)).code, 'WEIXIN_SEND_OUTCOME_UNKNOWN');
  const status = await f.backend.callTool('weixin.get_message_status', { request_id: received.messages[0].request_id }, f.context);
  assert.equal(status.hasUnknownOutcome, true);
  assert.equal(f.counts().sendCalls, 1);
});

test('wrong correlation and competing reply text cannot select a different destination', async t => {
  const f = await fixture(t);
  await receive(f);
  await assert.rejects(f.backend.callTool('weixin.deliver_owner_reply', reply(f, { message_id: 'another' }), f.context), { code: 'CORRELATION_MISMATCH' });
  await f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context);
  await assert.rejects(f.backend.callTool('weixin.deliver_owner_reply', reply(f, { text: 'different' }), f.context), { code: 'DEPENDENCY_FAILURE' });
  assert.equal(f.counts().sendCalls, 1);
});

test('unsubscribe during pending event invalidates its late completion and cancels locally', async t => {
  const wait = deferred(), entered = deferred();
  const f = await fixture(t, { publish: async () => { entered.resolve(); await wait.promise; return { outcome: 'ACCEPTED' }; } });
  await subscribed(f);
  const polling = f.backend.pollOwner(f.context);
  await entered.promise;
  const unsubscribe = f.backend.unsubscribe(removeParams(), f.context);
  await new Promise(resolve => setImmediate(resolve));
  wait.resolve();
  await assert.rejects(polling, { code: 'SUBSCRIPTION_INACTIVE', outcome: 'OUTCOME_UNKNOWN' });
  await unsubscribe;
  const status = await f.backend.callTool('weixin.get_message_status', { request_id: f.events[0].data.request_id }, f.context);
  assert.equal(status.journal.cancelled, true);
  assert.equal(status.journal.uplink, 'OUTCOME_UNKNOWN');
  assert.equal(status.state, 'WAITING_CONFIRMATION');
});

test('abort after sending cannot record late success or retry', async t => {
  const wait = deferred(), entered = deferred(), controller = new AbortController();
  const f = await fixture(t, { send: async () => { entered.resolve(); await wait.promise; return new Response('{"ret":0}', { status: 200 }); } });
  const received = await receive(f);
  const sending = f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context, { signal: controller.signal });
  await entered.promise;
  controller.abort(); wait.resolve();
  await assert.rejects(sending, { code: 'OPERATION_CANCELLED', outcome: 'OUTCOME_UNKNOWN' });
  const status = await f.backend.callTool('weixin.get_message_status', { request_id: received.messages[0].request_id }, f.context);
  assert.equal(status.journal.downlink, 'OUTCOME_UNKNOWN');
  await f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context);
  assert.equal(f.counts().sendCalls, 1);
});

test('expired unknown remains unknown, expiry never permits another send', async t => {
  const f = await fixture(t, { send: async () => { throw new Error('timeout'); } });
  const received = await receive(f);
  await f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context);
  f.setTime(700001);
  const status = await f.backend.callTool('weixin.get_message_status', { request_id: received.messages[0].request_id }, f.context);
  assert.equal(status.expired, true);
  assert.equal(status.reason, 'OUTCOME_UNKNOWN');
  await assert.rejects(f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context), { code: 'SUBSCRIPTION_INACTIVE' });
  assert.equal(f.counts().sendCalls, 1);
});

test('backend restart has no inherited subscription and journal never redispatches old event', async t => {
  const f = await fixture(t);
  const received = await receive(f);
  await f.backend.close();
  const restarted = createLoopbackBackend(f.options);
  t.after(() => restarted.close());
  await assert.rejects(restarted.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
  await assert.rejects(restarted.callTool('weixin.get_message_status', { request_id: received.messages[0].request_id }, f.context));
  await restarted.subscribe(params(), f.context);
  const recovery = await restarted.pollOwner(f.context, { pendingOnly: true });
  assert.equal(recovery.messages[0].code, 'DUPLICATE_NOT_REPLAYED');
  assert.equal(f.events.length, 1);
  assert.equal(f.counts().sendCalls, 0);
});

test('oversized unicode and untrusted resource selectors reject before any effect', async t => {
  const f = await fixture(t);
  await receive(f);
  await assert.rejects(f.backend.callTool('weixin.deliver_owner_reply', reply(f, { text: '😀'.repeat(600) }), f.context), { code: 'INVALID_REPLY_ARGUMENTS' });
  await assert.rejects(f.backend.readResource('dots-wechat://message/%zz/status', f.context), { code: 'RESOURCE_NOT_FOUND' });
  await assert.rejects(f.backend.readResource('file:///etc/passwd', f.context), { code: 'RESOURCE_NOT_FOUND' });
  f.setAllowed(false);
  await assert.rejects(f.backend.callTool('weixin.get_message_status', { request_id: f.events[0].data.request_id }, f.context), error => !error.message.includes('fixture-token-not-real'));
  assert.equal(f.counts().sendCalls, 0);
});

test('encrypted journal close and reopen retains unknown without restoring a subscription', async t => {
  const f = await fixture(t, { send: async () => { throw new Error('timeout'); } });
  const received = await receive(f);
  await f.backend.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context);
  await f.backend.close();
  await f.journal.close();
  const reopenedJournal = await openJournal({ directory: f.journalDirectory, key: f.key, mode: 'open', clock: f.options.clock });
  const restarted = createLoopbackBackend({ ...f.options, journal: reopenedJournal });
  try {
    const record = await reopenedJournal.readStatus({ tenantId: principal.tenantId, subject: principal.subject, requestId: received.messages[0].request_id });
    assert.equal(record.downlink, 'OUTCOME_UNKNOWN');
    assert.equal(record.retryAutomatically, false);
    await assert.rejects(restarted.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
    await assert.rejects(restarted.callTool('weixin.deliver_owner_reply', replyArgs(f), f.context), { code: 'CORRELATION_MISMATCH' });
    assert.equal(f.counts().sendCalls, 1);
  } finally { await restarted.close(); await reopenedJournal.close(); }
});

test('verification finishing after requested lifetime cannot activate and clock rollback fails closed', async t => {
  const wait = deferred(), entered = deferred();
  const f = await fixture(t, { verify: async () => { entered.resolve(); await wait.promise; return { verified: true }; } });
  const activation = subscribed(f);
  await entered.promise;
  f.setTime(700001); wait.resolve();
  await assert.rejects(activation, { code: 'CALLBACK_NOT_VERIFIED' });
  f.setTime(1);
  await assert.rejects(f.backend.pollOwner(f.context), { code: 'CLOCK_MOVED_BACKWARDS' });
  assert.equal(f.counts().networkCalls, 0);
});

test('event discovery uses payloadSchema and webhook delivery and publisher receives full stable envelope', async t => {
  const f = await fixture(t);
  const event = backendCatalog.events[0];
  assert.deepEqual(event.delivery, ['webhook']);
  assert.equal(Object.hasOwn(event, 'outputSchema'), false);
  assert.equal(event.payloadSchema.properties.text.type, 'string');
  const received = await receive(f);
  const published = f.events[0];
  assert.deepEqual(Object.keys(published).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp']);
  assert.equal(published.eventId, received.messages[0].event_id);
  assert.equal(published.eventId, published.data.event_id);
  assert.equal(published.timestamp, '1970-01-01T00:01:40.000Z');
  assert.equal(published.cursor, null);
  await f.backend.pollOwner(f.context, { pendingOnly: true });
  assert.equal(f.events.length, 1);
});

test('canonical subscription identity is stable and same-key refresh re-verifies callback and extends finite expiry', async t => {
  let verified = 0;
  const f = await fixture(t, { verify: async () => { verified++; return { verified: true }; } });
  const first = await subscribed(f);
  assert.match(first.subscriptionId, /^wx-sub:[a-f0-9]{64}$/u);
  f.setTime(200000);
  const equivalent = params(); equivalent.delivery.url = 'https://CALLBACK.EXAMPLE.TEST:443/events';
  const refreshed = await f.backend.subscribe(equivalent, f.context);
  assert.equal(refreshed.subscriptionId, first.subscriptionId);
  assert.equal(first.expiresAtMs, 700000);
  assert.equal(refreshed.expiresAtMs, 800000);
  assert.equal(verified, 2);
  assert.equal(JSON.stringify(refreshed).includes('whsec_'), false);
  await f.backend.close();
  const restarted = createLoopbackBackend(f.options);
  try {
    const recreated = await restarted.subscribe(params(), f.context);
    assert.equal(recreated.subscriptionId, first.subscriptionId);
    assert.equal(verified, 3);
  } finally { await restarted.close(); }
});

test('requested permanent and very long subscriptions are granted only finite local/auth lifetimes', async t => {
  const f = await fixture(t);
  const permanent = params(); permanent.ttlMs = null;
  assert.deepEqual(loopbackOperationSchemas.subscribe.properties.ttlMs.type, ['integer', 'null']);
  const first = await f.backend.subscribe(permanent, f.context);
  assert.equal(first.expiresAtMs, 700000);
  f.setTime(200000);
  const long = params(); long.ttlMs = Number.MAX_SAFE_INTEGER;
  const refreshed = await f.backend.subscribe(long, f.context);
  assert.equal(refreshed.subscriptionId, first.subscriptionId);
  assert.equal(refreshed.expiresAtMs, 800000);
  f.setTime(3600000);
  const nearGrantEnd = await f.backend.subscribe(long, f.context);
  assert.equal(nearGrantEnd.expiresAtMs, 3700000);
  const invalid = params(); invalid.ttlMs = 0;
  await assert.rejects(f.backend.subscribe(invalid, f.context), { code: 'INVALID_TTL' });
});

test('authorized unsubscribe is idempotent for absent, active and already removed subscription', async t => {
  const f = await fixture(t);
  const absent = await f.backend.unsubscribe(removeParams(), f.context);
  const created = await subscribed(f);
  assert.equal(absent.subscriptionId, created.subscriptionId);
  const first = await f.backend.unsubscribe(removeParams(), f.context);
  const second = await f.backend.unsubscribe(removeParams(), f.context);
  assert.deepEqual(second, first);
  assert.equal(first.unsubscribed, true);
  await assert.rejects(f.backend.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
  f.setAllowed(false);
  await assert.rejects(f.backend.unsubscribe(removeParams(), f.context), { code: 'AUTHORIZATION_REJECTED' });
  assert.equal(f.counts().networkCalls, 0);
});

test('secret rotation is explicitly unsupported, including after in-process expiration', async t => {
  let verified = 0;
  const f = await fixture(t, { verify: async () => { verified++; return { verified: true }; } });
  await subscribed(f);
  const rotated = params(); rotated.delivery.secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
  await assert.rejects(f.backend.subscribe(rotated, f.context), { code: 'SECRET_ROTATION_NOT_IMPLEMENTED' });
  f.setTime(700001);
  await assert.rejects(f.backend.subscribe(rotated, f.context), { code: 'SECRET_ROTATION_NOT_IMPLEMENTED' });
  assert.equal(verified, 1);
  assert.equal(f.counts().networkCalls, 0);
});

test('callback rejection on refresh does not extend prior subscription', async t => {
  let verified = 0;
  const f = await fixture(t, { verify: async () => ({ verified: ++verified === 1 }) });
  await subscribed(f);
  f.setTime(200000);
  await assert.rejects(subscribed(f), { code: 'CALLBACK_NOT_VERIFIED' });
  f.setTime(700001);
  await assert.rejects(f.backend.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
  assert.equal(verified, 2);
});

test('unsubscribe racing refresh prevents late verified activation', async t => {
  const entered = deferred(), wait = deferred();
  let verified = 0;
  const f = await fixture(t, { verify: async () => {
    if (++verified === 2) { entered.resolve(); await wait.promise; }
    return { verified: true };
  } });
  await subscribed(f);
  f.setTime(200000);
  const refresh = subscribed(f);
  await entered.promise;
  const removal = f.backend.unsubscribe(removeParams(), f.context);
  await new Promise(resolve => setImmediate(resolve));
  wait.resolve();
  await assert.rejects(refresh, { code: 'SUBSCRIPTION_CHANGED' });
  await removal;
  await assert.rejects(f.backend.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
  assert.equal(f.counts().networkCalls, 0);
});

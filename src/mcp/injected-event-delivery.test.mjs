import test from 'node:test';
import assert from 'node:assert/strict';
import { createInjectedEventDelivery } from './injected-event-delivery.mjs';
import { decodeVerificationRequest, encodeVerificationResponse, decodeOwnerEventRequest } from './event-wire.mjs';

const principal = { tenantId: 'synthetic-tenant', subject: 'synthetic-owner', grantId: 'synthetic-grant', bindingId: 'synthetic-binding', watchId: 'synthetic-watch', generation: 1, revision: 1 };
const candidate = () => ({ subscriptionId: 'synthetic-subscription', principal, authorizationExpiresAtMs: 700000, expiresAtMs: 600000, delivery: { mode: 'webhook', url: 'https://callback.example.test/no-network', secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}` } });
const event = () => ({ eventId: 'synthetic-event', name: 'weixin.owner_message', timestamp: '2026-10-01T12:00:00.000Z', cursor: null, data: { request_id: 'synthetic-request', message_id: 'synthetic-message', event_id: 'synthetic-event', subscription_id: 'synthetic-subscription', binding_id: principal.bindingId, generation: 1, text: 'synthetic input only' } });
const decode = (wire, sub = candidate(), nowSeconds = 100) => ({ method: wire.method, secret: sub.delivery.secret, headers: wire.headers, rawBody: Buffer.from(wire.body), nowSeconds, expectedSubscriptionId: sub.subscriptionId });
const challengeReply = wire => ({ status: 200, rawBody: encodeVerificationResponse(decodeVerificationRequest(decode(wire)).challenge) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('injected challenge and event use signed exact bodies without a default network implementation', async () => {
  assert.throws(() => createInjectedEventDelivery(), { code: 'INJECTED_TRANSPORT_REQUIRED' });
  const wires = [];
  const adapter = createInjectedEventDelivery({ clock: () => 100000, transport: async wire => {
    wires.push(wire);
    assert.equal(wire.redirect, 'error');
    assert.ok(Object.isFrozen(wire.headers));
    if (wires.length === 1) return challengeReply(wire);
    assert.equal(decodeOwnerEventRequest({ ...decode(wire), expectedBindingId: principal.bindingId, expectedGeneration: 1 }).data.text, 'synthetic input only');
    return { status: 202, rawBody: Buffer.alloc(0) };
  } });
  assert.deepEqual(await adapter.verifySubscription(candidate()), { verified: true });
  assert.deepEqual(await adapter.verifySubscription(candidate()), { verified: true });
  assert.equal(wires.length, 1);
  assert.deepEqual(await adapter.publishEvent(event(), candidate()), { outcome: 'ACCEPTED' });
  assert.equal(wires.length, 2);
  assert.equal(adapter.status().liveEnabled, false);
  assert.equal(adapter.status().existingDot, 'not_verified');
  adapter.close();
});

test('wrong challenge, rejection and malformed response never activate synthetic delivery', async () => {
  for (const response of [{ status: 200, rawBody: Buffer.from('{"challenge":"different"}') }, { status: 302, rawBody: Buffer.from('{}') }, { status: 200, rawBody: Buffer.from('{"challenge":"x","extra":true}') }, { status: 200, rawBody: Buffer.alloc(262145) }]) {
    let calls = 0;
    const adapter = createInjectedEventDelivery({ clock: () => 100000, transport: async () => { calls++; return response; } });
    assert.deepEqual(await adapter.verifySubscription(candidate()), { verified: false });
    await assert.rejects(adapter.publishEvent(event(), candidate()), { code: 'CALLBACK_NOT_VERIFIED' });
    assert.equal(calls, 1);
    adapter.close();
  }
});

test('definitive rejection and unknown outcomes are distinct and no implicit resend occurs', async () => {
  for (const [status, outcome] of [[204, 'ACCEPTED'], [410, 'REJECTED'], [413, 'REJECTED'], [408, 'OUTCOME_UNKNOWN'], [429, 'OUTCOME_UNKNOWN'], [503, 'OUTCOME_UNKNOWN'], [302, 'OUTCOME_UNKNOWN']]) {
    let calls = 0;
    const adapter = createInjectedEventDelivery({ clock: () => 100000, transport: async wire => ++calls === 1 ? challengeReply(wire) : { status, rawBody: Buffer.alloc(0) } });
    await adapter.verifySubscription(candidate());
    assert.deepEqual(await adapter.publishEvent(event(), candidate()), { outcome });
    assert.equal(calls, 2);
    assert.equal(adapter.status().automaticRetry, false);
    adapter.close();
  }
});

test('injected transport stall is bounded and an uncertain event is not retried', async () => {
  let calls = 0, aborted = false;
  const adapter = createInjectedEventDelivery({ clock: () => 100000, timeoutMs: 5, transport: async (wire, { signal }) => {
    calls++;
    if (calls === 1) return challengeReply(wire);
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } });
  await adapter.verifySubscription(candidate());
  assert.deepEqual(await adapter.publishEvent(event(), candidate()), { outcome: 'OUTCOME_UNKNOWN' });
  assert.equal(aborted, true);
  assert.equal(calls, 2);
  adapter.close();
});

test('cancellation during verification cannot activate a late synthetic callback', async () => {
  const entered = deferred(), finish = deferred(), controller = new AbortController();
  const adapter = createInjectedEventDelivery({ clock: () => 100000, transport: async wire => { entered.resolve(); await finish.promise; return challengeReply(wire); } });
  const checking = adapter.verifySubscription(candidate(), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(checking, { code: 'OPERATION_CANCELLED' });
  finish.resolve();
  await assert.rejects(adapter.publishEvent(event(), candidate()), { code: 'CALLBACK_NOT_VERIFIED' });
  adapter.close();
});

test('closing cancels stalled injected verification and late completion stays inactive', async () => {
  const entered = deferred(), finish = deferred();
  const adapter = createInjectedEventDelivery({ clock: () => 100000, transport: async wire => { entered.resolve(); await finish.promise; return challengeReply(wire); } });
  const checking = adapter.verifySubscription(candidate());
  await entered.promise;
  adapter.close();
  await assert.rejects(checking, { code: 'DELIVERY_CLOSED' });
  finish.resolve();
  await assert.rejects(adapter.publishEvent(event(), candidate()), { code: 'DELIVERY_CLOSED' });
});

test('cache is bound to principal, secret, generation, deadline and callback URL', async () => {
  const adapter = createInjectedEventDelivery({ clock: () => 100000, transport: async wire => challengeReply(wire) });
  await adapter.verifySubscription(candidate());
  for (const changed of [sub => { sub.principal = { ...principal, generation: 2 }; }, sub => { sub.delivery.secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`; }, sub => { sub.delivery.url += '/other'; }, sub => { sub.expiresAtMs -= 1; }]) {
    const sub = candidate(); changed(sub);
    await assert.rejects(adapter.publishEvent(event(), sub), { code: 'CALLBACK_NOT_VERIFIED' });
  }
  adapter.close();
});

test('expired subscription and mismatched event are rejected before transport', async () => {
  let calls = 0, time = 100000;
  const adapter = createInjectedEventDelivery({ clock: () => time, transport: async wire => { calls++; return challengeReply(wire); } });
  await adapter.verifySubscription(candidate());
  const wrong = event(); wrong.data.subscription_id = 'other';
  await assert.rejects(adapter.publishEvent(wrong, candidate()), { code: 'SUBSCRIPTION_MISMATCH' });
  const otherBinding = event(); otherBinding.data.binding_id = 'other';
  await assert.rejects(adapter.publishEvent(otherBinding, candidate()), { code: 'BINDING_MISMATCH' });
  const otherGeneration = event(); otherGeneration.data.generation = 2;
  await assert.rejects(adapter.publishEvent(otherGeneration, candidate()), { code: 'GENERATION_MISMATCH' });
  time = 600000;
  await assert.rejects(adapter.publishEvent(event(), candidate()), { code: 'SUBSCRIPTION_EXPIRED' });
  assert.equal(calls, 1);
  adapter.close();
});

test('close from transport cleanup cannot reactivate a completed challenge', async () => {
  let adapter;
  adapter = createInjectedEventDelivery({ clock: () => 100000, transport: async (wire, { signal }) => {
    signal.addEventListener('abort', () => adapter.close());
    return challengeReply(wire);
  } });
  await assert.rejects(adapter.verifySubscription(candidate()), { code: 'DELIVERY_CLOSED' });
  assert.equal(adapter.status().closed, true);
});

test('caller cancellation from transport cleanup makes late event acceptance unknown', async () => {
  const controller = new AbortController();
  let calls = 0;
  const adapter = createInjectedEventDelivery({ clock: () => 100000, transport: async (wire, { signal }) => {
    calls++;
    if (calls === 1) return challengeReply(wire);
    signal.addEventListener('abort', () => controller.abort());
    return { status: 202, rawBody: Buffer.alloc(0) };
  } });
  await adapter.verifySubscription(candidate());
  assert.deepEqual(await adapter.publishEvent(event(), candidate(), { signal: controller.signal }), { outcome: 'OUTCOME_UNKNOWN' });
  assert.equal(calls, 2);
  adapter.close();
});

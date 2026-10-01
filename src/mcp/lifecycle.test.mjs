import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLoopbackBackend } from './backend.mjs';
import { openJournal } from '../journal/journal.mjs';
import { createWeixinTextClient } from '../weixin/client.mjs';
import { createPrivateStateStore } from '../weixin/private-state-store.mjs';
import { createInjectedEventDelivery } from './injected-event-delivery.mjs';
import { decodeVerificationRequest, encodeVerificationResponse, decodeOwnerEventRequest } from './event-wire.mjs';

const principal = Object.freeze({ tenantId: 'synthetic-tenant', subject: 'synthetic-owner', grantId: 'synthetic-grant', bindingId: 'synthetic-binding', watchId: 'synthetic-watch', generation: 1, revision: 1 });
const subscription = () => ({ name: 'weixin.owner_message', arguments: { binding_id: principal.bindingId, generation: 1 }, delivery: { mode: 'webhook', url: 'https://callback.example.test/no-network', secret: `whsec_${Buffer.alloc(32, 2).toString('base64')}` } });
const message = id => ({ from_user_id: 'synthetic-owner', to_user_id: 'synthetic-bot', message_id: String(id), message_type: 1, message_state: 2, context_token: `synthetic-context-${id}`, item_list: [{ type: 1, text_item: { text: `synthetic input ${id}` } }] });

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dots-local-lifecycle-')));
  await chmod(directory, 0o700);
  const statePath = path.join(directory, 'synthetic-state.json');
  const journalPath = path.join(directory, 'journal');
  const context = Object.freeze({ capability: 'synthetic-only' });
  const events = [], sends = [], cursors = [], batches = [];
  let time = 100000, unknown = false, backend, weixin, journal, eventDelivery;
  const open = async mode => {
    journal = await openJournal({ directory: journalPath, key: Buffer.alloc(32, 6), mode, clock: () => time });
    if (mode === 'create') await journal.bind({ principal, expiresAt: 700000, expectedRevision: 0 });
    weixin = createWeixinTextClient({ enabled: true, botToken: 'synthetic-token-not-real', botId: 'synthetic-bot', ownerUserId: 'synthetic-owner', now: () => time, wallNow: () => time, stateStore: await createPrivateStateStore({ statePath }), fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body);
      if (url.endsWith('/getupdates')) {
        cursors.push(body.get_updates_buf);
        return new Response(JSON.stringify({ msgs: batches.shift() ?? [], get_updates_buf: `synthetic-cursor-${cursors.length}` }));
      }
      assert.ok(url.endsWith('/sendmessage'));
      sends.push(body.msg);
      return new Response(unknown ? '{}' : '{"ret":0}');
    } });
    eventDelivery = createInjectedEventDelivery({ clock: () => time, transport: async wire => {
      const detail = { method: wire.method, secret: subscription().delivery.secret, headers: wire.headers, rawBody: Buffer.from(wire.body), nowSeconds: Math.floor(time / 1000), expectedSubscriptionId: wire.headers['X-MCP-Subscription-Id'] };
      if (JSON.parse(wire.body).type === 'verification') return { status: 200, rawBody: encodeVerificationResponse(decodeVerificationRequest(detail).challenge) };
      assert.ok(JSON.parse(await readFile(statePath, 'utf8')).cursor.startsWith('synthetic-cursor-'));
      events.push(decodeOwnerEventRequest({ ...detail, expectedBindingId: principal.bindingId, expectedGeneration: principal.generation }));
      return { status: 202, rawBody: Buffer.alloc(0) };
    } });
    backend = createLoopbackBackend({ mode: 'injected-local', journal, weixin, correlationKey: Buffer.alloc(32, 9), clock: () => time, authorize: async value => {
      assert.equal(value, context);
      return { principal, expiresAtMs: 700000 };
    }, verifySubscription: eventDelivery.verifySubscription, publishEvent: eventDelivery.publishEvent });
  };
  const close = async () => { eventDelivery.close(); await backend.close(); await weixin.close(); await journal.close(); };
  await open('create');
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  return { events, sends, cursors, batches, setUnknown: value => { unknown = value; }, get backend() { return backend; }, context, async restart() { await close(); time += 1000; await open('open'); } };
}

const deliver = (f, event, replyId) => f.backend.callTool('weixin.deliver_owner_reply', { ...event.data, reply_id: replyId, text: 'synthetic reply only' }, f.context);

test('synthetic maximum provider batch reaches events after durable cursor and exact original reply context', async t => {
  const f = await fixture(t);
  f.batches.push(Array.from({ length: 128 }, (_, index) => message(index + 1)));
  await f.backend.subscribe(subscription(), f.context);
  const result = await f.backend.pollOwner(f.context);
  assert.equal(result.messages.length, 128);
  assert.ok(result.messages.every(row => row.code === 'MCP_EVENT_ACCEPTED'));
  assert.equal(f.events.length, 128);
  const sent = await deliver(f, f.events[127], 'synthetic-reply-128');
  assert.equal(sent.code, 'WEIXIN_API_ACCEPTED');
  assert.equal(sent.deliveryConfirmed, false);
  assert.equal(f.sends[0].context_token, 'synthetic-context-128');
  assert.equal(f.sends[0].to_user_id, 'synthetic-owner');
});

test('synthetic pending recovery accepts more than one provider batch without replay', async t => {
  const f = await fixture(t);
  await f.backend.subscribe(subscription(), f.context);
  f.batches.push(Array.from({ length: 128 }, (_, index) => message(index + 1)), [message(129)]);
  await f.backend.pollOwner(f.context);
  await f.backend.pollOwner(f.context);
  const result = await f.backend.pollOwner(f.context, { pendingOnly: true });
  assert.equal(result.messages.length, 129);
  assert.ok(result.messages.every(row => row.code === 'DUPLICATE_NOT_REPLAYED'));
  assert.equal(f.events.length, 129);
  assert.equal(f.sends.length, 0);
});

test('synthetic restart retains unknown send and permits a new round only after subscription revalidation', async t => {
  const f = await fixture(t);
  await f.backend.subscribe(subscription(), f.context);
  f.batches.push([message(1)]);
  await f.backend.pollOwner(f.context);
  f.setUnknown(true);
  assert.equal((await deliver(f, f.events[0], 'synthetic-old-reply')).code, 'WEIXIN_SEND_OUTCOME_UNKNOWN');
  await f.restart();
  await assert.rejects(f.backend.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
  await assert.rejects(deliver(f, f.events[0], 'synthetic-old-reply'), { code: 'CORRELATION_MISMATCH' });
  assert.equal(f.sends.length, 1);
  await f.backend.subscribe(subscription(), f.context);
  f.batches.push([message(1), message(2)]);
  f.setUnknown(false);
  const next = await f.backend.pollOwner(f.context);
  assert.equal(next.messages.length, 1);
  assert.equal(f.events.length, 2);
  assert.equal((await deliver(f, f.events[1], 'synthetic-new-reply')).code, 'WEIXIN_API_ACCEPTED');
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].context_token, 'synthetic-context-2');
  assert.equal(f.cursors[1], 'synthetic-cursor-1');
});

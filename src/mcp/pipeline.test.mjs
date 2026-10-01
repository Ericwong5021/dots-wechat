import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLoopbackBackend } from './backend.mjs';
import { startLocalMcpService, PROTOCOL_VERSION } from './server.mjs';

import { openJournal } from '../journal/journal.mjs';
import { createWeixinTextClient } from '../weixin/client.mjs';
import { createPrivateStateStore } from '../weixin/private-state-store.mjs';
const meta = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
const principal = { tenantId: 'synthetic-tenant', subject: 'synthetic-owner', grantId: 'synthetic-grant', bindingId: 'synthetic-binding', watchId: 'synthetic-watch', generation: 1, revision: 1 };
const eventArgs = () => ({ name: 'weixin.owner_message', arguments: { binding_id: principal.bindingId, generation: 1 }, delivery: { mode: 'webhook', url: 'https://callback.example.test/never-contacted', secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}` } });

async function fixture(t, { unknown = false } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dots-http-pipeline-')));
  await chmod(directory, 0o700);
  const statePath = path.join(directory, 'synthetic-state.json');
  const context = Object.freeze({ testCapability: 'not-a-live-grant' });
  const journal = await openJournal({ directory: path.join(directory, 'journal'), key: Buffer.alloc(32, 9), mode: 'create', clock: () => 100000 });
  await journal.bind({ principal, expiresAt: 700000, expectedRevision: 0 });
  const events = [], sent = [], cursors = [];
  const weixin = createWeixinTextClient({ enabled: true, botToken: 'synthetic-token-not-real', botId: 'synthetic-bot', ownerUserId: 'synthetic-owner', now: () => 100000, wallNow: () => 100000, stateStore: await createPrivateStateStore({ statePath }), fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/getupdates')) {
      cursors.push(body.get_updates_buf);
      return new Response(JSON.stringify({ get_updates_buf: 'synthetic-next-cursor', msgs: [{ from_user_id: 'synthetic-owner', to_user_id: 'synthetic-bot', message_id: '123456', message_type: 1, message_state: 2, context_token: 'synthetic-private-context', item_list: [{ type: 1, text_item: { text: 'synthetic owner input' } }] }] }));
    }
    assert.ok(url.endsWith('/sendmessage'));
    sent.push(body.msg);
    return new Response(unknown ? '{}' : '{"message_id":18446744073709551615}');
  } });
  const backend = createLoopbackBackend({ mode: 'injected-local', journal, weixin, clock: () => 100000, correlationKey: Buffer.alloc(32, 6), authorize: async (value, detail) => {
    assert.equal(value, context);
    assert.ok(['weixin.events.subscribe', 'weixin.events.unsubscribe', 'weixin.owner.ingress', 'weixin.message.deliver', 'gateway.status.read'].includes(detail.purpose));
    return { principal, expiresAtMs: 700000 };
  }, verifySubscription: async () => ({ verified: true }), publishEvent: async event => {
    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    assert.ok(JSON.stringify(stored).includes('synthetic-next-cursor'));
    events.push(event); return { outcome: 'ACCEPTED' };
  } });
  const service = await startLocalMcpService({ port: 0, backend, resolveContext: async () => context });
  const client = new Client({ name: 'synthetic-http-pipeline', version: '1' }, { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.address.url)));
  t.after(async () => { await client.close(); await service.close(); await weixin.close(); await journal.close(); await rm(directory, { recursive: true, force: true }); });
  const eventRpc = async (method, params) => {
    const response = await fetch(service.address.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': method, 'mcp-protocol-version': PROTOCOL_VERSION }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { backend, client, service, eventRpc, context, events, sent, cursors, statePath };
}

test('real MCP HTTP → subscription → durable WeChat adapter → event → exact reply → status uses only injected network', async t => {
  const f = await fixture(t);
  const subscribed = await f.eventRpc('events/subscribe', eventArgs());
  assert.ok(subscribed.result.id);
  assert.equal(subscribed.result.refreshBefore, new Date(700000).toISOString());
  assert.equal(subscribed.result.cursor, null);
  assert.equal(subscribed.result.truncated, false);
  assert.equal(subscribed.result.subscriptionId, undefined);
  const received = await f.backend.pollOwner(f.context);
  assert.equal(received.messages[0].code, 'MCP_EVENT_ACCEPTED');
  assert.equal(f.events.length, 1);
  const data = f.events[0].data;
  assert.equal(data.subscription_id, subscribed.result.id);
  let status = await f.client.callTool({ name: 'weixin.get_message_status', arguments: { request_id: data.request_id } });
  assert.equal(status.structuredContent.state, 'PROCESSING');
  const reply = { ...data, reply_id: 'synthetic-reply-1', text: 'synthetic response, no real dot' };
  const result = await f.client.callTool({ name: 'weixin.deliver_owner_reply', arguments: reply });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.code, 'WEIXIN_API_ACCEPTED');
  assert.equal(result.structuredContent.deliveryConfirmed, false);
  assert.equal(result.structuredContent.existingDot, 'not_verified');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to_user_id, 'synthetic-owner');
  assert.equal(f.sent[0].context_token, 'synthetic-private-context');
  await f.client.callTool({ name: 'weixin.deliver_owner_reply', arguments: reply });
  assert.equal(f.sent.length, 1);
  const resource = await f.client.readResource({ uri: `dots-wechat://message/${encodeURIComponent(data.request_id)}/status` });
  status = JSON.parse(resource.contents[0].text);
  assert.equal(status.state, 'WAITING_CONFIRMATION');
  assert.equal(status.dot.internalState, 'NOT_EXPOSED');
  assert.equal(status.dot.existingDotBinding, 'NOT_VERIFIED_BY_THIS_MODULE');
  await f.backend.pollOwner(f.context);
  assert.deepEqual(f.cursors, ['', 'synthetic-next-cursor']);
  assert.equal(f.events.length, 1);
  const state = await readFile(f.statePath, 'utf8');
  for (const value of ['synthetic-token-not-real', 'synthetic-private-context', 'synthetic owner input']) assert.equal(state.includes(value), false);
  const remove = eventArgs(); delete remove.delivery.secret;
  const unsubscribed = (await f.eventRpc('events/unsubscribe', remove)).result;
  assert.equal(unsubscribed.resultType, 'complete');
  assert.equal(unsubscribed.unsubscribed, undefined);
  await assert.rejects(f.backend.pollOwner(f.context), { code: 'SUBSCRIPTION_REQUIRED' });
});

test('HTTP tool duplicate cannot resend an unknown provider outcome, and wrong message correlation has no effect', async t => {
  const f = await fixture(t, { unknown: true });
  await f.eventRpc('events/subscribe', eventArgs());
  await f.backend.pollOwner(f.context);
  const data = f.events[0].data;
  const reply = { ...data, reply_id: 'synthetic-reply-unknown', text: 'synthetic response' };
  const forged = await f.client.callTool({ name: 'weixin.deliver_owner_reply', arguments: { ...reply, message_id: 'another-message' } });
  assert.equal(forged.isError, true);
  assert.equal(f.sent.length, 0);
  for (let count = 0; count < 2; count++) {
    const result = await f.client.callTool({ name: 'weixin.deliver_owner_reply', arguments: reply });
    assert.equal(result.structuredContent.code, 'WEIXIN_SEND_OUTCOME_UNKNOWN');
    assert.equal(result.structuredContent.retryAutomatically, false);
  }
  assert.equal(f.sent.length, 1);
  const status = await f.client.callTool({ name: 'weixin.get_message_status', arguments: { request_id: data.request_id } });
  assert.equal(status.structuredContent.reason, 'OUTCOME_UNKNOWN');
  assert.equal(status.structuredContent.state, 'WAITING_CONFIRMATION');
});

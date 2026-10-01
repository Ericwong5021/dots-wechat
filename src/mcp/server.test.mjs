import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startLocalMcpService, PROTOCOL_VERSION } from './server.mjs';
import { createLoopbackBackend, LoopbackBackendError } from './backend.mjs';

const meta = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
export async function rpc(service, method, params = {}, options = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': method, ...options.headers };
  if (method === 'tools/call') headers['mcp-name'] = params.name;
  if (method === 'resources/read') headers['mcp-name'] = params.uri;
  const response = await fetch(service.address.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method, params: { ...params, _meta: meta } }), signal: options.signal });
  return response;
}

async function fixture(t, options = {}) {
  const service = await startLocalMcpService({ port: 0, ...options });
  t.after(() => service.close());
  return service;
}

test('real TCP discovery advertises current protocol, exact tool/event/resource catalog and honest disabled health', async t => {
  const service = await fixture(t);
  assert.equal(service.address.host, '127.0.0.1');
  const health = await (await fetch(new URL('/healthz', service.address.url))).json();
  assert.equal(health.transport, 'LOOPBACK_HTTP');
  assert.equal(health.liveEnabled, false);
  assert.equal(health.automaticPolling, false);
  assert.equal(health.existingDot, 'not_verified');
  const response = await rpc(service, 'server/discover');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { result } = await response.json();
  assert.deepEqual(result.supportedVersions, [PROTOCOL_VERSION]);
  assert.deepEqual(result.capabilities.events, {});
  assert.equal(result.capabilities.resources.subscribe, false);
  assert.equal(result.resultType, 'complete');
  const tools = (await (await rpc(service, 'tools/list')).json()).result.tools;
  assert.deepEqual(tools.map(item => item.name), ['weixin.deliver_owner_reply', 'weixin.get_message_status']);
  assert.ok(tools.every(item => item.inputSchema.additionalProperties === false));
  const events = (await (await rpc(service, 'events/list')).json()).result.events;
  assert.deepEqual(events.map(item => item.name), ['weixin.owner_message']);
  assert.deepEqual(events[0].delivery, ['webhook']);
  assert.equal(events[0].payloadSchema.type, 'object');
  assert.equal(events[0].outputSchema, undefined);
  assert.equal((await (await rpc(service, 'resources/list')).json()).result.resources[0].uri, 'dots-wechat://gateway/status');
  assert.equal((await (await rpc(service, 'resources/templates/list')).json()).result.resourceTemplates.length, 1);
});

test('official v2 Client discovers, lists and reads over the actual Node socket', async t => {
  const service = await fixture(t);
  const client = new Client({ name: 'synthetic-local-test', version: '1' }, { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(service.address.url)));
  assert.equal(client.getServerVersion().name, 'dots-wechat-local');
  assert.equal((await client.listTools()).tools.length, 2);
  const result = await client.readResource({ uri: 'dots-wechat://gateway/status' });
  assert.equal(JSON.parse(result.contents[0].text).configured, false);
  const denied = await client.callTool({ name: 'weixin.get_message_status', arguments: { request_id: 'synthetic-unavailable' } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.code, 'BACKEND_NOT_CONFIGURED');
});

test('forged bearer and model supplied owner meta never enable subscriptions or reply effects', async t => {
  const service = await fixture(t);
  const parameters = { name: 'weixin.owner_message', arguments: { binding_id: 'synthetic-binding', generation: 1 }, delivery: { mode: 'webhook', url: 'https://callback.example.test/events', secret: `whsec_${Buffer.alloc(32).toString('base64')}` } };
  const response = await rpc(service, 'events/subscribe', parameters, { headers: { authorization: 'Bearer synthetic-not-authenticated', 'x-owner': 'owner' } });
  const value = await response.json();
  assert.equal(value.error.message, 'BACKEND_NOT_CONFIGURED');
  assert.equal(value.error.data.liveEnabled, false);
  assert.equal(JSON.stringify(value).includes(parameters.delivery.secret), false);
  assert.equal(service.status().publisherConfigured, false);
  assert.equal(service.status().weixinConfigured, false);
});

test('SDK POST SSE acknowledges catalog filter, refuses private resource feeds and cleans up disconnect', async t => {
  const service = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await rpc(service, 'subscriptions/listen', { notifications: { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['dots-wechat://message/not-authorized/status'] } }, { id: 'synthetic-listen', signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/u);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /notifications\/subscriptions\/acknowledged/u);
  assert.match(first, /synthetic-listen/u);
  assert.doesNotMatch(first, /not-authorized/u);
  assert.equal(service.status().subscriptions, 1);
  service.notifyCatalogChanged();
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /notifications\/(tools|resources)\/list_changed/u);
  assert.doesNotMatch(next, /context_token|synthetic owner message/u);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 30 && service.status().subscriptions !== 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.status().subscriptions, 0);
});

test('SSE count is bounded and stopping listener releases active streams and port', async t => {
  const service = await fixture(t, { limits: { subscriptions: 1 } });
  const response = await rpc(service, 'subscriptions/listen', { notifications: { toolsListChanged: true } });
  const reader = response.body.getReader();
  await reader.read();
  const denied = await rpc(service, 'subscriptions/listen', { notifications: { toolsListChanged: true } }, { id: 2 });
  assert.match((await denied.json()).error.message, /Subscription limit/u);
  await service.close();
  assert.equal(service.status().subscriptions, 0);
  await reader.cancel().catch(() => {});
  await assert.rejects(fetch(new URL('/healthz', service.address.url), { signal: AbortSignal.timeout(1000) }));
});

test('tool failures preserve uncertain effects and never echo dependency exception details', async t => {
  const base = createLoopbackBackend();
  let error = new LoopbackBackendError('EFFECT_RECORD_UNAVAILABLE', 'OUTCOME_UNKNOWN');
  const service = await fixture(t, { backend: { ...base, callTool: async () => { throw error; } } });
  const params = { name: 'weixin.get_message_status', arguments: { request_id: 'synthetic-request' } };
  const first = (await (await rpc(service, 'tools/call', params)).json()).result;
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent.outcome, 'OUTCOME_UNKNOWN');
  assert.equal(first.structuredContent.retryAutomatically, false);
  error = new Error('synthetic-secret-body-path-must-never-leak');
  const second = await (await rpc(service, 'tools/call', params)).json();
  assert.equal(second.result.structuredContent.code, 'BACKEND_REQUEST_REJECTED');
  assert.equal(JSON.stringify(second).includes(error.message), false);
});

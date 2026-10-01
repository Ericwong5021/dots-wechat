import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { startLocalMcpService, PROTOCOL_VERSION, DEFAULT_LIMITS } from './server.mjs';

const meta = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
const rpc = (method = 'server/discover', params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } });
const headers = (method = 'server/discover', extra = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': method, ...extra });
const quietBackend = () => ({
  catalog: {
    tools: [{ name: 'test.status', description: 'Synthetic status only', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }],
    resources: [{ uri: 'test://status', name: 'Synthetic status', mimeType: 'application/json' }],
    resourceTemplates: []
  },
  status: () => ({ mode: 'synthetic', liveEnabled: false }),
  callTool: async (_name, _args, context) => {
    if (context === undefined) throw new Error('SYNTHETIC_UNAUTHORIZED');
    return { synthetic: true };
  },
  readResource: async () => ({ synthetic: true }),
  listEvents: async () => ({ events: [] }),
  subscribe: async () => { throw new Error('SYNTHETIC_UNAUTHORIZED'); },
  unsubscribe: async () => { throw new Error('SYNTHETIC_UNAUTHORIZED'); },
  close: async () => {}
});

async function serve(t, options = {}) {
  const service = await startLocalMcpService({ port: 0, backend: quietBackend(), ...options });
  t.after(async () => { await service.close(); });
  return service;
}

async function post(service, payload = rpc(), extra = {}) {
  return fetch(service.address.url, { method: 'POST', headers: headers(payload.method, extra), body: JSON.stringify(payload) });
}

function raw(port, content, { timeoutMs = 1500, maxBytes = 262144 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TEST_SOCKET_TIMEOUT')); }, timeoutMs);
    socket.on('connect', () => socket.write(content));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { socket.destroy(); reject(new Error('TEST_RESPONSE_TOO_LARGE')); }
      else chunks.push(chunk);
    });
    socket.on('error', error => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

function rawPost(service, lines = [], body = JSON.stringify(rpc())) {
  return `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${service.address.port}\r\nConnection: close\r\n${Object.entries(headers()).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

test('actual listener is loopback and unsafe bind options cannot open sockets', async t => {
  const service = await serve(t);
  assert.equal(service.address.host, '127.0.0.1');
  for (const host of ['0.0.0.0', '::', '192.0.2.1']) await assert.rejects(startLocalMcpService({ host }), /UNSUPPORTED_SERVICE_OPTION/);
  await assert.rejects(startLocalMcpService({ port: -1 }), /INVALID_PORT/);
  await assert.rejects(startLocalMcpService({ limits: { bodyBytes: DEFAULT_LIMITS.bodyBytes + 1 } }), /LIMIT_EXCEEDS_SAFE_DEFAULT/);
});

test('health is bounded non-sensitive discovery and emits no broad CORS header', async t => {
  const service = await serve(t);
  const response = await fetch(new URL('/healthz', service.address.url));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.liveEnabled, false);
  assert.equal(body.transport, 'LOOPBACK_HTTP');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(body), /context_token|credentials\.json|botToken|ownerUserId/u);
});

test('malicious or absent Host never reaches protocol discovery', async t => {
  const service = await serve(t);
  for (const host of ['example.invalid', `127.0.0.1.evil:${service.address.port}`, `localhost:${service.address.port + 1}`, `user@127.0.0.1:${service.address.port}`]) {
    const reply = await raw(service.address.port, `GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    assert.match(reply, /^HTTP\/1\.1 403 /u, host);
  }
  const absent = await raw(service.address.port, 'GET /healthz HTTP/1.0\r\nConnection: close\r\n\r\n');
  assert.match(absent, /^HTTP\/1\.1 403 /u);
});

test('all present Origins including null and same-local origin are denied', async t => {
  const service = await serve(t);
  for (const origin of ['https://example.invalid', 'null', `http://127.0.0.1:${service.address.port}`]) {
    const response = await post(service, rpc(), { origin });
    assert.equal(response.status, 403, origin);
    assert.equal((await response.json()).code, 'ORIGIN_REJECTED');
  }
});

test('forwarding headers cannot change the trusted host or scheme', async t => {
  const service = await serve(t);
  for (const key of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for']) {
    const response = await post(service, rpc(), { [key]: 'attacker.invalid' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'FORWARDED_HEADERS_REJECTED');
  }
});

test('duplicate security headers are rejected before body dispatch', async t => {
  const service = await serve(t);
  for (const lines of [
    [`Host: localhost:${service.address.port}`],
    ['Origin: https://a.invalid', 'Origin: https://b.invalid'],
    ['Authorization: Bearer synthetic-one', 'Authorization: Bearer synthetic-two'],
    ['Mcp-Method: tools/list'],
    ['Content-Length: 1']
  ]) {
    const reply = await raw(service.address.port, rawPost(service, lines));
    assert.match(reply, /^HTTP\/1\.1 400 /u);
  }
});

test('Origin beyond header-count limit cannot be silently dropped', async t => {
  const service = await serve(t);
  const padding = Array.from({ length: 55 }, (_, index) => `X-Test-Padding-${index}: x`);
  const reply = await raw(service.address.port, rawPost(service, [...padding, 'Origin: https://attacker.invalid']));
  assert.match(reply, /^HTTP\/1\.1 (?:400|403|431) /u);
  assert.doesNotMatch(reply, /supportedVersions/u);
});

test('request-body limits cover declared length and streaming chunked overflow', async t => {
  const service = await serve(t, { limits: { bodyBytes: 512 } });
  const response = await post(service, rpc('server/discover', { padding: 'x'.repeat(1024) }));
  assert.equal(response.status, 413);
  const chunks = 'x'.repeat(1024);
  const req = `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${service.address.port}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n${Object.entries(headers()).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${chunks.length.toString(16)}\r\n${chunks}\r\n0\r\n\r\n`;
  const reply = await raw(service.address.port, req);
  assert.match(reply, /^HTTP\/1\.1 413 /u);
});

test('body timeout terminates a partially sent request without backend use', async t => {
  let calls = 0;
  const backend = quietBackend();
  backend.callTool = async () => { calls += 1; return {}; };
  const service = await serve(t, { backend, limits: { bodyMs: 80, headerMs: 80, callMs: 300 } });
  const req = `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${service.address.port}\r\nContent-Length: 1000\r\n${Object.entries(headers('tools/call')).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n{`;
  const started = Date.now();
  const reply = await raw(service.address.port, req);
  assert.ok(Date.now() - started < 1200);
  assert.ok(reply === '' || /^HTTP\/1\.1 (?:400|408|504) /u.test(reply));
  assert.equal(calls, 0);
});

test('header timeout closes sockets that never complete request headers', async t => {
  const service = await serve(t, { limits: { headerMs: 80, bodyMs: 200 } });
  const started = Date.now();
  const reply = await raw(service.address.port, 'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:');
  assert.ok(Date.now() - started < 1200);
  assert.ok(reply === '' || /^HTTP\/1\.1 (?:400|408) /u.test(reply));
});

test('oversized headers fail at the actual HTTP parser boundary', async t => {
  const service = await serve(t, { limits: { headerBytes: 512 } });
  const reply = await raw(service.address.port, rawPost(service, [`X-Oversized: ${'x'.repeat(1024)}`]));
  assert.match(reply, /^HTTP\/1\.1 (?:400|431) /u);
});

test('no legacy handshake, GET stream, DELETE session, replay or path alias', async t => {
  const service = await serve(t);
  for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
    const response = await fetch(service.address.url, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  for (const path of ['/mcp/', '/mcp?live=1', '/.runtime/credentials.json']) {
    const response = await fetch(new URL(path, service.address.url));
    assert.equal(response.status, 404);
  }
  for (const header of ['mcp-session-id', 'last-event-id']) {
    const response = await post(service, rpc(), { [header]: 'synthetic-old' });
    assert.equal(response.status, 400);
  }
  const response = await post(service, rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  assert.ok(response.status >= 400);
});

test('unsupported content encoding and content type are denied', async t => {
  const service = await serve(t);
  const encoding = await post(service, rpc(), { 'content-encoding': 'gzip' });
  assert.equal(encoding.status, 415);
  const media = await post(service, rpc(), { 'content-type': 'text/plain' });
  assert.equal(media.status, 415);
});

test('Accept negotiation requires both JSON and SSE response support', async t => {
  const service = await serve(t);
  for (const accept of ['application/json', 'text/event-stream', 'application/json, text/event-stream;q=0', 'application/json, text/event-stream;q=0.000', 'application/json, text/event-stream;q=bogus', '*/*']) {
    const response = await post(service, rpc(), { accept });
    assert.equal(response.status, 406, accept);
  }
  for (const accept of ['Application/JSON, Text/Event-Stream', 'application/json;q=1.0, text/event-stream;q=0.5']) {
    const response = await post(service, rpc(), { accept });
    assert.equal(response.status, 200, accept);
  }
});

test('per-request method, version and resource URI mirrors are verified', async t => {
  const service = await serve(t);
  for (const extra of [{ 'mcp-method': 'tools/list' }, { 'mcp-protocol-version': '2025-11-25' }]) {
    const response = await post(service, rpc(), extra);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32020);
  }
  for (const name of [undefined, 'test://different']) {
    const extra = name === undefined ? {} : { 'mcp-name': name };
    const response = await post(service, rpc('resources/read', { uri: 'test://status' }), extra);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32020);
  }
});

test('unknown method and unsupported protocol version return structured failures', async t => {
  const service = await serve(t);
  const unknown = await post(service, rpc('madeup/action'));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, -32601);
  const payload = rpc();
  payload.params._meta = { ...meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' };
  const version = await post(service, payload, { 'mcp-protocol-version': '1900-01-01' });
  assert.equal(version.status, 400);
  assert.equal((await version.json()).error.code, -32022);
});

test('malformed UTF-8, JSON and batch requests do not poison the next connection', async t => {
  const service = await serve(t);
  for (const body of [Buffer.from([0xff, 0xfe]), '{"jsonrpc":', '[]', JSON.stringify([rpc()])]) {
    const response = await fetch(service.address.url, { method: 'POST', headers: headers(), body });
    assert.ok(response.status >= 400, String(body));
  }
  const healthy = await post(service);
  assert.equal(healthy.status, 200);
});

test('wire bearer and principal-like metadata do not create trusted context', async t => {
  let contexts = [];
  const backend = quietBackend();
  backend.callTool = async (_name, _args, context) => {
    contexts.push(context);
    throw new Error('SECRET_EXCEPTION_SHOULD_NOT_ESCAPE');
  };
  const service = await serve(t, { backend });
  const payload = rpc('tools/call', { name: 'test.status', arguments: {} });
  payload.params._meta = { ...meta, principal: { owner: true }, liveEnabled: true };
  const response = await post(service, payload, { authorization: 'Bearer SYNTHETIC_WIRE_TOKEN', 'mcp-name': 'test.status' });
  const text = await response.text();
  assert.deepEqual(contexts, [undefined]);
  assert.match(text, /BACKEND_REQUEST_REJECTED/u);
  assert.doesNotMatch(text, /SYNTHETIC_WIRE_TOKEN|SECRET_EXCEPTION_SHOULD_NOT_ESCAPE/u);
});

test('request deadline releases concurrency and aborts pending backend work', async t => {
  let startedResolve, abortResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const aborted = new Promise(resolve => { abortResolve = resolve; });
  const backend = quietBackend();
  backend.callTool = async (_name, _args, _context, { signal }) => {
    startedResolve();
    signal.addEventListener('abort', abortResolve, { once: true });
    return new Promise(() => {});
  };
  const service = await serve(t, { backend, limits: { callMs: 100, concurrent: 1 } });
  const waiting = post(service, rpc('tools/call', { name: 'test.status', arguments: {} }), { 'mcp-name': 'test.status' }).then(response => response.text()).catch(() => 'closed');
  await started;
  const overflow = await post(service);
  assert.equal(overflow.status, 503);
  assert.equal((await overflow.json()).code, 'CONCURRENCY_LIMIT');
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('NO_ABORT')), 1000))]);
  await waiting;
  const healthy = await post(service);
  assert.equal(healthy.status, 200);
});

test('context resolved after request timeout cannot dispatch backend work', async t => {
  let resolveContext, enteredResolve;
  const context = new Promise(resolve => { resolveContext = resolve; });
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  let effects = 0;
  const backend = quietBackend();
  backend.callTool = async () => { effects += 1; return { synthetic: true }; };
  const service = await serve(t, {
    backend,
    resolveContext: async () => { enteredResolve(); return context; },
    limits: { callMs: 60 }
  });
  const waiting = post(service, rpc('tools/call', { name: 'test.status', arguments: {} }), { 'mcp-name': 'test.status' }).then(response => response.text()).catch(() => 'closed');
  await entered;
  await waiting;
  resolveContext({ synthetic: true });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(effects, 0);
  assert.equal(service.status().inFlight, 0);
});

test('close is idempotent and promptly closes an active request socket', async t => {
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  let backendClosed = 0;
  const backend = quietBackend();
  backend.callTool = async () => { startedResolve(); return new Promise(() => {}); };
  backend.close = async () => { backendClosed += 1; };
  const service = await serve(t, { backend });
  const waiting = post(service, rpc('tools/call', { name: 'test.status', arguments: {} }), { 'mcp-name': 'test.status' }).catch(() => null);
  await started;
  const began = Date.now();
  await Promise.all([service.close(), service.close()]);
  await waiting;
  assert.ok(Date.now() - began < 1500);
  assert.equal(backendClosed, 1);
  assert.equal(service.status().closed, true);
  assert.equal(service.status().inFlight, 0);
});

test('port conflict does not stop or mutate the original service', async t => {
  const service = await serve(t);
  await assert.rejects(startLocalMcpService({ port: service.address.port, backend: quietBackend() }), { code: 'EADDRINUSE' });
  const response = await fetch(new URL('/healthz', service.address.url));
  assert.equal(response.status, 200);
});

test('automatic lifetime shuts down without an external process or public listener', async t => {
  const service = await serve(t, { durationMs: 60 });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(service.status().closed, true);
  await assert.rejects(fetch(new URL('/healthz', service.address.url)));
});

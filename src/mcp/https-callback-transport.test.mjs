import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { createHttpsCallbackTransport, isPublicCallbackIPv4 } from './https-callback-transport.mjs';

const host = 'callback.example.test';
const body = '{ "type": "verification", "challenge": "synthetic-only-中文" }';
const bytes = Buffer.from(body);
const signature = data => `v1,${createHmac('sha256', Buffer.alloc(32, 7)).update('synthetic-id.1.').update(data).digest('base64')}`;
const wire = () => ({ url: `https://${host}/synthetic-only?x=1`, method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'webhook-id': 'synthetic-id', 'webhook-timestamp': '1', 'webhook-signature': signature(bytes), 'X-MCP-Subscription-Id': 'synthetic-subscription' }, body });
const publicDNS = [{ address: '8.8.8.8', family: 4 }];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ dns = () => publicDNS, action = (_req, response) => { response.emit('data', Buffer.from('{}')); response.emit('end'); }, status = 200, headers = {}, timeoutMs = 10000 } = {}) {
  const calls = [], resolutions = [], requests = [], responses = [];
  const transport = createHttpsCallbackTransport({
    isTrustedHostname: name => name === host,
    resolve: async (name, options) => { resolutions.push({ name, options }); return dns(name, options); },
    request: (options, callback) => {
      calls.push(options);
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = () => { req.destroyed = true; };
      req.end = sent => {
        req.sent = Buffer.from(sent);
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = status;
          response.headers = headers;
          response.complete = true;
          response.destroyed = false;
          response.destroy = () => { response.destroyed = true; response.emit('close'); };
          responses.push(response);
          callback(response);
          if (!response.destroyed) action(req, response);
        });
      };
      requests.push(req);
      return req;
    }, timeoutMs,
  });
  return { transport, calls, resolutions, requests, responses };
}

test('factory requires all three explicit trusted dependencies and a bounded deadline', () => {
  for (const args of [undefined, {}, { resolve() {}, request() {} }, { isTrustedHostname() {}, request() {} }, { isTrustedHostname() {}, resolve() {} }]) {
    assert.throws(() => createHttpsCallbackTransport(args), { code: 'EXPLICIT_HTTPS_DEPENDENCIES_REQUIRED' });
  }
  for (const timeoutMs of [0, 10001, Infinity, 0.5]) assert.throws(() => createHttpsCallbackTransport({ isTrustedHostname() {}, resolve() {}, request() {}, timeoutMs }), { code: 'INVALID_CALLBACK_DEADLINE' });
});

test('all IANA special purpose IPv4 ranges plus multicast are conservatively denied', () => {
  const denied = [
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.127.255.255',
    '127.0.0.0', '127.255.255.255', '169.254.0.0', '169.254.255.255', '172.16.0.0', '172.31.255.255',
    '192.0.0.0', '192.0.0.255', '192.0.0.9', '192.0.0.10', '192.0.0.170', '192.0.0.171',
    '192.0.2.0', '192.0.2.255', '192.31.196.0', '192.31.196.255', '192.52.193.0', '192.52.193.255',
    '192.88.99.0', '192.88.99.255', '192.168.0.0', '192.168.255.255', '192.175.48.0', '192.175.48.255',
    '198.18.0.0', '198.19.255.255', '198.51.100.0', '198.51.100.255', '203.0.113.0', '203.0.113.255',
    '224.0.0.0', '239.255.255.255', '240.0.0.0', '255.255.255.255',
    '::1', '::ffff:8.8.8.8', '8.8.8.08', '2130706433', '8.8.8.8 ', undefined,
  ];
  for (const address of denied) assert.equal(isPublicCallbackIPv4(address), false, String(address));
  for (const address of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '223.255.255.255']) assert.equal(isPublicCallbackIPv4(address), true, address);
});

test('pins validated IPv4 while retaining original TLS identity and Host without rewriting signed bytes', async () => {
  const f = fixture();
  assert.deepEqual(await f.transport(wire()), { status: 200, rawBody: Buffer.from('{}') });
  const options = f.calls[0];
  assert.equal(options.hostname, '8.8.8.8');
  assert.equal(options.servername, host);
  assert.equal(options.headers.host, host);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.family, 4);
  assert.equal(options.port, 443);
  assert.equal(options.agent, false);
  assert.equal(options.insecureHTTPParser, false);
  assert.equal(options.maxHeaderSize, 16384);
  assert.equal(options.path, '/synthetic-only?x=1');
  assert.equal(options.headers['content-length'], String(bytes.length));
  assert.equal(options.headers['webhook-signature'], signature(f.requests[0].sent));
  assert.deepEqual(f.requests[0].sent, bytes);
  assert.equal(f.resolutions[0].name, host);
  assert.deepEqual({ ...f.resolutions[0].options, signal: undefined }, { all: true, family: 4, verbatim: true, signal: undefined });
  options.lookup(host, {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  options.lookup(host, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, publicDNS); });
  assert.equal(options.checkServerIdentity('8.8.8.8', { subjectaltname: `DNS:${host}` }), undefined);
  assert.equal(options.checkServerIdentity(host, { subjectaltname: 'IP Address:8.8.8.8' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('body and headers are snapshotted before asynchronous DNS resolution', async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({ dns: () => { entered.resolve(); return pending.promise; } });
  const input = wire(); input.body = Buffer.from(bytes);
  const result = f.transport(input);
  await entered.promise;
  input.body.fill(0); input.headers['webhook-signature'] = 'changed'; input.url = 'https://untrusted.example.test/';
  pending.resolve(publicDNS);
  await result;
  assert.deepEqual(f.requests[0].sent, bytes);
  assert.equal(f.calls[0].headers['webhook-signature'], signature(bytes));
});

test('each request re-resolves and private DNS rebinding is blocked before another connection', async () => {
  let count = 0;
  const f = fixture({ dns: () => ++count === 1 ? publicDNS : [{ address: '127.0.0.1', family: 4 }] });
  await f.transport(wire());
  await assert.rejects(f.transport(wire()), { code: 'NON_PUBLIC_OR_UNSUPPORTED_ADDRESS' });
  assert.equal(f.resolutions.length, 2); assert.equal(f.calls.length, 1);
});

test('rejects mixed private/public answers, IPv6 and malformed/empty DNS results', async () => {
  for (const addresses of [[...publicDNS, { address: '169.254.169.254', family: 4 }], [{ address: '::1', family: 6 }], [{ address: '2606:4700:4700::1111', family: 6 }], [{ address: '8.8.8.8', family: 6 }], [{ address: 'garbage', family: 4 }], [], null, Array(33).fill(publicDNS[0])]) {
    const f = fixture({ dns: () => addresses });
    await assert.rejects(f.transport(wire()));
    assert.equal(f.calls.length, 0);
  }
});

test('HTTPS syntax, literal IP, nonstandard port and untrusted hostname fail before DNS', async () => {
  for (const url of ['http://callback.example.test/', 'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/', 'https://[::ffff:8.8.8.8]/', 'https://callback.example.test:444/', 'https://callback.example.test@evil.example.test/', 'https://user:pass@callback.example.test/', 'https://callback.example.test/#fragment', 'https://callback.example.test/#', 'https://callback.example.test./', 'https://untrusted.example.test/', 'https://callback.example.test\\@evil.example.test/']) {
    const f = fixture();
    await assert.rejects(f.transport({ ...wire(), url }));
    assert.equal(f.resolutions.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('untrusted policy results and exceptions fail closed', async () => {
  for (const isTrustedHostname of [() => false, () => 'true', () => Promise.resolve(true), () => { throw new Error('synthetic secret'); }]) {
    const transport = createHttpsCallbackTransport({ isTrustedHostname, resolve: async () => { assert.fail('DNS must not run'); }, request: () => assert.fail('request must not run') });
    await assert.rejects(transport(wire()), { code: 'UNTRUSTED_CALLBACK_HOSTNAME' });
  }
});

test('request body is bounded at 256 KiB with no JSON parse or serialization', async () => {
  const f = fixture();
  await f.transport({ ...wire(), body: Buffer.alloc(262144, 32) });
  assert.equal(f.requests[0].sent.length, 262144);
  for (const body of [Buffer.alloc(262145), '中'.repeat(87382), '', {}, '\ud800']) await assert.rejects(f.transport({ ...wire(), body }));
  assert.equal(f.calls.length, 1);
});

test('rejects request header injection and unsupported methods or redirect policies', async () => {
  const f = fixture();
  for (const change of [input => { input.headers.Host = 'evil.example.test'; }, input => { input.headers.Authorization = 'synthetic-secret'; }, input => { input.headers['webhook-id'] = 'x\r\ny'; }, input => { input.headers['WEBHOOK-ID'] = 'duplicate'; }, input => { input.method = 'GET'; }, input => { input.redirect = 'follow'; }, input => { delete input.headers['webhook-signature']; }]) {
    const input = wire(); change(input); await assert.rejects(f.transport(input));
  }
  assert.equal(f.resolutions.length, 0);
});

test('redirects are rejected and never followed regardless of Location', async () => {
  for (const status of [300, 301, 302, 303, 307, 308, 399]) {
    const f = fixture({ status, headers: { location: 'http://127.0.0.1/synthetic-only' } });
    await assert.rejects(f.transport(wire()), { code: 'CALLBACK_REDIRECT_BLOCKED' });
    assert.equal(f.calls.length, 1); assert.equal(f.requests[0].destroyed, true); assert.equal(f.responses[0].destroyed, true);
  }
});

test('bounded response accepts exact cap and rejects oversized declared or streamed responses', async () => {
  const exact = fixture({ headers: { 'content-length': '262144' }, action: (_req, response) => { response.emit('data', Buffer.alloc(262144)); response.emit('end'); } });
  assert.equal((await exact.transport(wire())).rawBody.length, 262144);
  for (const options of [{ headers: { 'content-length': '262145' } }, { action: (_req, response) => { response.emit('data', Buffer.alloc(262144)); response.emit('data', Buffer.alloc(1)); } }]) {
    const f = fixture(options);
    await assert.rejects(f.transport(wire()), { code: 'CALLBACK_RESPONSE_TOO_LARGE' });
    assert.equal(f.requests[0].destroyed, true); assert.equal(f.responses[0].destroyed, true);
  }
});

test('malformed and incomplete responses reject with redacted errors', async () => {
  const cases = [
    { headers: { 'content-length': 'bad' } }, { status: NaN },
    { headers: { 'content-length': '10' } },
    { action: (_req, response) => response.emit('data', 'decoded text') },
    { action: (_req, response) => response.emit('aborted') },
    { action: (_req, response) => response.emit('close') },
    { action: (_req, response) => response.emit('error', new Error('synthetic secret url body')) },
    { action: (_req, response) => { response.complete = false; response.emit('end'); } },
  ];
  for (const options of cases) {
    const f = fixture(options);
    await assert.rejects(f.transport(wire()), error => { assert.match(error.code, /^CALLBACK_|^INVALID_CALLBACK_/u); assert.equal(error.message, error.code); assert.equal(error.cause, undefined); return true; });
    assert.equal(f.requests[0].destroyed, true);
  }
});

test('DNS timeout aborts resolver and cannot launch a late connection', async () => {
  const pending = deferred();
  const f = fixture({ dns: () => pending.promise, timeoutMs: 5 });
  await assert.rejects(f.transport(wire()), { code: 'CALLBACK_TIMEOUT' });
  assert.equal(f.resolutions[0].options.signal.aborted, true);
  pending.resolve(publicDNS); await new Promise(done => setImmediate(done));
  assert.equal(f.calls.length, 0);
});

test('response timeout destroys both request and response', async () => {
  const f = fixture({ action() {}, timeoutMs: 5 });
  await assert.rejects(f.transport(wire()), { code: 'CALLBACK_TIMEOUT' });
  assert.equal(f.requests[0].destroyed, true); assert.equal(f.responses[0].destroyed, true); assert.equal(f.calls[0].signal.aborted, true);
});

test('connection stall is covered by the same deadline before any response exists', async () => {
  let req, calls = 0;
  const transport = createHttpsCallbackTransport({ isTrustedHostname: () => true, resolve: async () => publicDNS, timeoutMs: 5, request: () => {
    calls++;
    req = new EventEmitter();
    req.end = () => {};
    req.destroy = () => { req.destroyed = true; };
    return req;
  } });
  await assert.rejects(transport(wire()), { code: 'CALLBACK_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(req.destroyed, true);
});

test('unexpected input getter exceptions are redacted before network dependencies', async () => {
  const f = fixture();
  const input = wire();
  Object.defineProperty(input, 'url', { get() { throw new Error('synthetic secret url body'); } });
  await assert.rejects(f.transport(input), { message: 'INVALID_CALLBACK_REQUEST', code: 'INVALID_CALLBACK_REQUEST' });
  assert.equal(f.resolutions.length, 0);
});

test('pre-abort and cancellation during DNS prevent connections and late acceptance', async () => {
  const controller = new AbortController(); controller.abort();
  const pre = fixture(); await assert.rejects(pre.transport(wire(), { signal: controller.signal }), { code: 'OPERATION_CANCELLED' });
  assert.equal(pre.resolutions.length, 0);
  const pending = deferred(), entered = deferred(), active = new AbortController();
  const f = fixture({ dns: () => { entered.resolve(); return pending.promise; } });
  const result = f.transport(wire(), { signal: active.signal });
  await entered.promise; active.abort();
  await assert.rejects(result, { code: 'OPERATION_CANCELLED' });
  pending.resolve(publicDNS); await new Promise(done => setImmediate(done));
  assert.equal(f.calls.length, 0); assert.equal(f.resolutions[0].options.signal.aborted, true);
});

test('cancellation after connection destroys pending streams and prevents late success', async () => {
  const entered = deferred(), controller = new AbortController();
  const f = fixture({ action: () => entered.resolve() });
  const result = f.transport(wire(), { signal: controller.signal });
  await entered.promise; controller.abort();
  await assert.rejects(result, { code: 'OPERATION_CANCELLED' });
  assert.equal(f.requests[0].destroyed, true); assert.equal(f.responses[0].destroyed, true);
  f.responses[0].emit('end');
  assert.equal(f.calls.length, 1);
});

test('DNS/request/TLS errors expose no dependency message, URL, body or signature and never retry', async () => {
  const f = fixture({ dns: () => { throw new Error('synthetic secret body url'); } });
  await assert.rejects(f.transport(wire()), { message: 'CALLBACK_DNS_ERROR', code: 'CALLBACK_DNS_ERROR' });
  assert.equal(f.calls.length, 0);
  const tls = fixture({ action: req => req.emit('error', new Error('TLS synthetic signature body url')) });
  await assert.rejects(tls.transport(wire()), { message: 'CALLBACK_REQUEST_ERROR', code: 'CALLBACK_REQUEST_ERROR' });
  assert.equal(tls.calls.length, 1);
  const transport = createHttpsCallbackTransport({ isTrustedHostname: () => true, resolve: async () => publicDNS, request: () => { throw new Error('synthetic secret body url'); } });
  await assert.rejects(transport(wire()), { message: 'CALLBACK_REQUEST_ERROR', code: 'CALLBACK_REQUEST_ERROR' });
});

test('nonredirect error statuses remain available to the owner delivery outcome mapper', async () => {
  for (const status of [202, 204, 400, 408, 410, 413, 429, 503]) {
    const f = fixture({ status });
    assert.equal((await f.transport(wire())).status, status);
    assert.equal(f.calls.length, 1);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthHttpGate, PROTECTED_RESOURCE_PATHS } from './oauth-http.mjs';
import { startLocalMcpService, PROTOCOL_VERSION } from './server.mjs';

const resourceUrl = 'https://synthetic-resource.example/mcp';
const issuer = 'https://synthetic-issuer.example/tenant';
const configuration = authenticate => ({ resourceUrl, issuer, scopes: ['synthetic:read'], authenticate });
const backend = () => ({
  catalog: { tools: [{ name: 'synthetic.read', description: 'Synthetic only', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], resources: [], resourceTemplates: [] },
  status: () => ({ liveEnabled: false }),
  callTool: async (_name, _args, context) => ({ tenant: context?.tenant ?? 'anonymous' }),
  readResource: async () => ({}), listEvents: async () => ({ events: [] }), subscribe: async () => ({}), unsubscribe: async () => ({}), close: async () => {}
});
const rpc = (method = 'tools/call') => ({ jsonrpc: '2.0', id: 1, method, params: { ...(method === 'tools/call' ? { name: 'synthetic.read', arguments: {} } : {}), _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {}, principal: { tenant: 'forged-owner' }, liveEnabled: true } } });
const headers = (token, method = 'tools/call') => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': 'synthetic.read' } : {}), ...(token === undefined ? {} : { authorization: token }) });
const post = (service, token, method = 'tools/call', body = JSON.stringify(rpc(method))) => fetch(service.address.url, { method: 'POST', headers: headers(token, method), body });
const serve = async (t, options = {}) => {
  const service = await startLocalMcpService({ port: 0, backend: backend(), ...options });
  t.after(() => service.close());
  return service;
};

test('configuration requires an external verifier and canonical HTTPS endpoint identifiers before listening', async () => {
  for (const oauth of [null, {}, { resourceUrl, issuer }, { ...configuration(async () => ({})), authenticate: true }, { ...configuration(async () => ({})), apiKey: 'synthetic-key' }]) {
    await assert.rejects(startLocalMcpService({ port: 0, oauth }), /INVALID_OAUTH_HTTP_CONFIGURATION|EXTERNAL_AUTHENTICATOR_REQUIRED/u);
  }
  for (const value of ['http://synthetic.example/mcp', 'https://user:pass@synthetic.example/mcp', 'https://127.0.0.1/mcp', 'https://[::1]/mcp', 'https://localhost/mcp', 'https://host.local/mcp', `${resourceUrl}?token=synthetic`, `${resourceUrl}#fragment`, 'https://synthetic-resource.example/mcp/', 'https://synthetic-resource.example/other', 'https://synthetic-resource.example/mcp%2fother']) {
    assert.throws(() => createOAuthHttpGate({ ...configuration(async () => ({})), resourceUrl: value }), /INVALID_OAUTH_RESOURCE_URL|OAUTH_RESOURCE_TARGET_MISMATCH/u);
  }
  for (const value of ['http://issuer.example/', 'https://issuer.example/?token=synthetic', 'https://issuer.example/#fragment', 'https://user@issuer.example/', 'https://issuer.example/\r\nInjected: yes']) {
    assert.throws(() => createOAuthHttpGate({ ...configuration(async () => ({})), issuer: value }), /INVALID_OAUTH_ISSUER/u);
  }
  for (const scopes of [['synthetic scope'], ['"injected'], ['back\\slash'], ['duplicate', 'duplicate'], [''], Array(17).fill('synthetic')]) {
    assert.throws(() => createOAuthHttpGate({ ...configuration(async () => ({})), scopes }), /INVALID_OAUTH_SCOPES/u);
  }
  await assert.rejects(startLocalMcpService({ port: 0, oauth: configuration(async () => ({})), resolveContext: async () => ({ tenant: 'bypass' }) }), /OAUTH_CONTEXT_RESOLVER_CONFLICT/u);
});

test('both exact metadata routes expose bounded configured identifiers without authentication or request-derived fields', async t => {
  let calls = 0;
  const service = await serve(t, { oauth: configuration(async () => { calls += 1; throw new Error('SYNTHETIC_SECRET'); }) });
  for (const path of PROTECTED_RESOURCE_PATHS) {
    const response = await fetch(new URL(path, service.address.url), { headers: { authorization: 'Bearer SYNTHETIC_SECRET' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 8192);
    assert.doesNotMatch(text, /SYNTHETIC_SECRET|owner|tenantId|chat|127\.0\.0\.1/u);
    assert.deepEqual(JSON.parse(text), { resource: resourceUrl, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['synthetic:read'] });
    const denied = await fetch(new URL(path, service.address.url), { method: 'POST' });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get('allow'), 'GET');
  }
  for (const path of ['/.well-known/oauth-protected-resource/mcp/', '/.well-known/oauth-protected-resource?resource=forged', '/.well-known/oauth-authorization-server']) {
    assert.equal((await fetch(new URL(path, service.address.url))).status, 404);
  }
  assert.equal(calls, 0);
});

test('missing, malformed and rejected bearer credentials challenge before protocol parsing or backend execution', async t => {
  let verifies = 0, effects = 0;
  const synthetic = backend();
  synthetic.callTool = async () => { effects += 1; return {}; };
  const service = await serve(t, { backend: synthetic, oauth: configuration(async () => { verifies += 1; throw new Error('SYNTHETIC_EXCEPTION_TOKEN'); }) });
  for (const token of [undefined, 'Basic SYNTHETIC_SECRET', 'Bearer', 'Bearer synthetic token', 'Bearer SYNTHETIC_SECRET']) {
    const response = await post(service, token, 'tools/call', '{malformed');
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="https://synthetic-resource.example/.well-known/oauth-protected-resource/mcp", scope="synthetic:read"`);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { code: 'HTTP_AUTHENTICATION_REQUIRED' });
    assert.doesNotMatch(text + response.headers.get('www-authenticate'), /SYNTHETIC_SECRET|SYNTHETIC_EXCEPTION_TOKEN|forged-owner/u);
  }
  assert.equal(verifies, 1);
  assert.equal(effects, 0);
  assert.equal((await fetch(service.address.url)).status, 401);
});

test('verifier results must carry external context rather than a flag, raw token or principal metadata', async t => {
  let result;
  const service = await serve(t, { oauth: configuration(async () => result) });
  for (result of [true, 'synthetic-token', null, {}, { context: undefined }, { context: true }, { context: [] }, { context: { tenant: 'synthetic' }, bearerToken: 'synthetic-token' }]) {
    assert.equal((await post(service, 'Bearer synthetic-token')).status, 401);
  }
  result = { context: { tenant: 'external-synthetic' } };
  const response = await post(service, 'Bearer synthetic-token');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.structuredContent.tenant, 'external-synthetic');
});

test('concurrent authenticated calls retain their own request and backend context across reversed verifier completion', async t => {
  const pending = new Map(), seen = [], reached = [];
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const synthetic = backend();
  synthetic.callTool = async (_name, _args, context) => {
    reached.push(context);
    await new Promise(resolve => setTimeout(resolve, context.tenant === 'one' ? 15 : 2));
    return { tenant: context.tenant, requestId: context.requestId };
  };
  const service = await serve(t, { backend: synthetic, oauth: configuration(input => {
    seen.push(input);
    if (seen.length === 2) readyResolve();
    return new Promise(resolve => pending.set(input.bearerToken, () => resolve({ context: { tenant: input.bearerToken, requestId: input.request.requestId } })));
  }) });
  const one = post(service, 'Bearer one'), two = post(service, 'Bearer two');
  await ready;
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].request.requestId, seen[1].request.requestId);
  for (const input of seen) {
    assert.equal(input.resourceUrl, resourceUrl);
    assert.equal(input.issuer, issuer);
    assert.deepEqual(input.requiredScopes, ['synthetic:read']);
    assert.deepEqual(Object.keys(input.request), ['requestId', 'method', 'target']);
    assert.equal(input.request.target, '/mcp');
    assert.equal(input.request.method, 'POST');
    assert.equal(Object.isFrozen(input.request), true);
  }
  pending.get('two')(); pending.get('one')();
  const results = await Promise.all([one, two].map(async promise => (await (await promise).json()).result.structuredContent));
  assert.deepEqual(results.map(value => value.tenant), ['one', 'two']);
  for (const result of results) assert.equal(result.requestId, seen.find(input => input.bearerToken === result.tenant).request.requestId);
  assert.equal(new Set(reached).size, 2);
  assert.ok(seen.every(input => input.signal.aborted));
});

test('a verifier cannot reuse a global context object for a second HTTP request', async t => {
  const shared = { tenant: 'global-synthetic' };
  const service = await serve(t, { oauth: configuration(async () => ({ context: shared })) });
  const first = await post(service, 'Bearer first');
  assert.equal(first.status, 200);
  await first.json();
  const second = await post(service, 'Bearer second');
  assert.equal(second.status, 401);
  assert.equal((await second.json()).code, 'HTTP_AUTHENTICATION_REQUIRED');
});

test('authentication covers discovery and a timed-out verifier cannot dispatch a late backend operation', async t => {
  let release, enteredResolve, signal, effects = 0, discovers = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const synthetic = backend();
  synthetic.callTool = async () => { effects += 1; return {}; };
  const service = await serve(t, { backend: synthetic, limits: { callMs: 70 }, oauth: configuration(input => {
    if (input.bearerToken === 'late') {
      signal = input.signal; enteredResolve();
      return new Promise(resolve => { release = resolve; });
    }
    discovers += 1;
    return { context: { tenant: 'fresh-synthetic' } };
  }) });
  const waiting = post(service, 'Bearer late').then(response => response.text()).catch(() => 'closed');
  await entered;
  await waiting;
  assert.equal(signal.aborted, true);
  release({ context: { tenant: 'late-synthetic' } });
  const healthy = await post(service, 'Bearer fresh', 'server/discover');
  assert.equal(healthy.status, 200);
  assert.equal(discovers, 1);
  assert.equal(effects, 0);
  assert.equal(service.status().inFlight, 0);
});

test('default disabled service neither advertises OAuth nor trusts wire credentials', async t => {
  const service = await serve(t);
  assert.equal((await fetch(new URL(PROTECTED_RESOURCE_PATHS[0], service.address.url))).status, 404);
  const response = await post(service, 'Bearer synthetic-owner');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.structuredContent.tenant, 'anonymous');
  assert.equal(service.status().liveEnabled, false);
});

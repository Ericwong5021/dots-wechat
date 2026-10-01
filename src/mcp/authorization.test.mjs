import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorizationCheckpoints, AuthorizationContractError, PRINCIPAL_FIELDS, MAX_AUTHORIZATION_TTL_MS } from './authorization.mjs';

const principal = () => ({ tenantId: 'synthetic-tenant', subject: 'synthetic-subject', grantId: 'synthetic-grant', bindingId: 'synthetic-binding', watchId: 'synthetic-watch', generation: 2, revision: 3 });
const detail = () => ({ purpose: 'synthetic:read', requestId: 'synthetic-request' });
const fixture = (overrides = {}) => {
  const state = { time: 100000, result: { principal: principal(), expiresAtMs: 101000 }, calls: [] };
  const options = { verifier: { authorize: async request => { state.calls.push(request); return state.result; } }, expectedPrincipal: principal(), clock: () => state.time, ...overrides };
  return { state, options, contract: createAuthorizationCheckpoints(options) };
};
const code = expected => error => error instanceof AuthorizationContractError && error.code === expected && error.retryAutomatically === false;

test('external verifier supplies a frozen isolated snapshot and is rerun at every checkpoint', async () => {
  const { state, contract } = fixture();
  const initial = await contract.authorize(detail());
  const second = await contract.checkpoint(initial, { purpose: 'synthetic:commit' });
  assert.deepEqual(initial, second);
  assert.notEqual(initial, second);
  assert.equal(state.calls.length, 2);
  assert.ok(Object.isFrozen(state.calls[0]));
  assert.ok(Object.isFrozen(initial));
  assert.ok(Object.isFrozen(initial.principal));
  state.result.principal.subject = 'synthetic-other';
  assert.equal(initial.principal.subject, 'synthetic-subject');
});

test('expected principal is snapshotted at composition time', async () => {
  const { options, contract } = fixture();
  options.expectedPrincipal.subject = 'synthetic-changed';
  options.verifier.authorize = async () => true;
  await contract.authorize(detail());
});

for (const key of PRINCIPAL_FIELDS) {
  test(`initial authorization binds exact expected principal field ${key}`, async () => {
    const { state, contract } = fixture();
    state.result.principal[key] = typeof state.result.principal[key] === 'number' ? 9 : 'synthetic-other';
    await assert.rejects(contract.authorize(detail()), code('PRINCIPAL_BINDING_MISMATCH'));
  });
  test(`checkpoint rejects drift in ${key}`, async () => {
    const { state, contract } = fixture();
    const initial = await contract.authorize(detail());
    state.result.principal[key] = typeof state.result.principal[key] === 'number' ? 9 : 'synthetic-other';
    await assert.rejects(contract.checkpoint(initial, detail()), code('STALE_AUTHORIZATION'));
  });
  test(`principal requires field ${key}`, async () => {
    const { state, contract } = fixture();
    delete state.result.principal[key];
    await assert.rejects(contract.authorize(detail()), code('AUTHORIZATION_REJECTED'));
  });
}

for (const value of [null, true, false, 'synthetic-jwt', [], {}, { verified: true }, { principal: principal(), expiresAtMs: 101000, verified: true }, { principal: principal(), expiresAtMs: 101000, _meta: {} }, { headers: { authorization: 'synthetic-only' } }, { claims: { sub: 'synthetic-subject' } }]) {
  test(`reject malformed or self-asserted verifier result ${JSON.stringify(value)}`, async () => {
    const { state, contract } = fixture();
    state.result = value;
    await assert.rejects(contract.authorize(detail()), code('AUTHORIZATION_REJECTED'));
  });
}

for (const field of ['tenantId', 'subject', 'grantId', 'bindingId', 'watchId']) {
  for (const invalid of ['', 'space id', 'synthetic\u0000', 'x'.repeat(513), 123, null]) {
    test(`reject invalid identifier ${field} ${JSON.stringify(invalid).slice(0, 60)}`, async () => {
      const { state, contract } = fixture();
      state.result.principal[field] = invalid;
      await assert.rejects(contract.authorize(detail()), code('AUTHORIZATION_REJECTED'));
    });
  }
}

for (const field of ['generation', 'revision']) {
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '2']) {
    test(`reject invalid positive integer ${field} ${String(invalid)}`, async () => {
      const { state, contract } = fixture();
      state.result.principal[field] = invalid;
      await assert.rejects(contract.authorize(detail()), code('AUTHORIZATION_REJECTED'));
    });
  }
}

test('expiry is strictly future, bounded to one hour, safe integer, and pinned across checkpoints', async () => {
  for (const expiry of [99999, 100000, 100000 + MAX_AUTHORIZATION_TTL_MS + 1, 100000.5, Infinity, '101000']) {
    const { state, contract } = fixture();
    state.result.expiresAtMs = expiry;
    await assert.rejects(contract.authorize(detail()), code('AUTHORIZATION_REJECTED'));
  }
  const { state, contract } = fixture();
  state.result.expiresAtMs = state.time + MAX_AUTHORIZATION_TTL_MS;
  const initial = await contract.authorize(detail());
  state.result.expiresAtMs -= 1;
  await assert.rejects(contract.checkpoint(initial, detail()), code('STALE_AUTHORIZATION'));
  state.result.expiresAtMs = initial.expiresAtMs;
  state.time = initial.expiresAtMs;
  await assert.rejects(contract.checkpoint(initial, detail()), code('AUTHORIZATION_REJECTED'));
});

test('checkpoint accepts only snapshots issued by its own instance', async () => {
  const one = fixture(), two = fixture();
  const initial = await one.contract.authorize(detail());
  for (const forged of [structuredClone(initial), { ...initial, verified: true }, initial.principal, true, null]) {
    await assert.rejects(one.contract.checkpoint(forged, detail()), code('UNTRUSTED_AUTHORIZATION_SNAPSHOT'));
  }
  await assert.rejects(two.contract.checkpoint(initial, detail()), code('UNTRUSTED_AUTHORIZATION_SNAPSHOT'));
  assert.equal(one.state.calls.length, 1);
  assert.equal(two.state.calls.length, 0);
});

test('no model metadata, unverified headers or JWT claims enter the contract input', async () => {
  const { state, contract } = fixture();
  for (const key of ['_meta', 'headers', 'authorization', 'claims', 'jwt', 'principal', 'verified']) {
    await assert.rejects(contract.authorize({ ...detail(), [key]: 'synthetic-only' }), code('INVALID_AUTHORIZATION_DETAIL'));
    assert.throws(() => createAuthorizationCheckpoints({ ...fixture().options, [key]: 'synthetic-only' }), code('INVALID_AUTHORIZATION_CONFIGURATION'));
  }
  assert.equal(state.calls.length, 0);
});

test('external verifier is mandatory and boolean flags cannot replace it', () => {
  for (const verifier of [undefined, true, false, {}, { verified: true }, { authorize: true }, { authorize: async () => true, verified: true }]) {
    assert.throws(() => createAuthorizationCheckpoints({ verifier, expectedPrincipal: principal(), clock: () => 100000 }), code('EXTERNAL_VERIFIER_REQUIRED'));
  }
  assert.throws(() => createAuthorizationCheckpoints({ verifier: { authorize: async () => true }, expectedPrincipal: { ...principal(), verified: true }, clock: () => 100000 }), code('INVALID_EXPECTED_PRINCIPAL'));
});

test('exact structures reject accessors, symbols, hidden fields and inherited principals', async () => {
  for (const make of [
    () => ({ ...principal(), extra: true }),
    () => Object.assign(Object.create({ subject: 'synthetic-subject' }), principal()),
    () => Object.defineProperty(principal(), 'subject', { get: () => { throw new Error('synthetic-getter'); } }),
    () => Object.defineProperty(principal(), 'hidden', { value: true }),
    () => Object.assign(principal(), { [Symbol('synthetic')]: true }),
  ]) {
    const { state, contract } = fixture();
    state.result.principal = make();
    await assert.rejects(contract.authorize(detail()), code('AUTHORIZATION_REJECTED'));
  }
  const { state, contract } = fixture();
  state.result.principal = Object.assign(Object.create(null), principal());
  await contract.authorize(detail());
});

test('verifier exceptions are sanitized and revocation is rechecked', async () => {
  let allowed = true;
  const { contract } = fixture({ verifier: { authorize: async () => {
    if (!allowed) throw new Error('synthetic-sensitive-error');
    return { principal: principal(), expiresAtMs: 101000 };
  } } });
  const initial = await contract.authorize(detail());
  allowed = false;
  await assert.rejects(contract.checkpoint(initial, detail()), error => code('AUTHORIZATION_REJECTED')(error) && !error.message.includes('sensitive'));
});

test('cancellation is checked before and after the verifier', async () => {
  const before = fixture(), control = new AbortController();
  control.abort();
  await assert.rejects(before.contract.authorize(detail(), { signal: control.signal }), code('OPERATION_CANCELLED'));
  assert.equal(before.state.calls.length, 0);
  const during = new AbortController();
  const after = fixture({ verifier: { authorize: async () => { during.abort(); return { principal: principal(), expiresAtMs: 101000 }; } } });
  await assert.rejects(after.contract.authorize(detail(), { signal: during.signal }), code('OPERATION_CANCELLED'));
  await assert.rejects(before.contract.authorize(detail(), { signal: { aborted: false, verified: true } }), code('INVALID_OPERATION_OPTIONS'));
});

test('clock cannot move backwards or become unsafe', async () => {
  for (const time of [99999, -1, Infinity, 100000.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { state, contract } = fixture();
    const initial = await contract.authorize(detail());
    state.time = time;
    await assert.rejects(contract.checkpoint(initial, detail()), code('CLOCK_MOVED_BACKWARDS'));
  }
});

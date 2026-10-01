import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHardLease, SESSION_MS } from './hard-lease.mjs';
import { createWatchdogCore, sanitizedEnvironment, tunnelCommand } from './watchdog.mjs';
import { createPrivateFiles, createSessionRunner, validateEvidence } from './session-runner.mjs';

const evidence = Object.freeze({ accountVerified: true, workspaceVerified: true, tunnelIdentityVerified: true, privateAccessVerified: true, newSessionTunnel: true, tunnelId: 'tunnel_synthetic123', billingKeyProbe: false, scope: 'health-discovery', liveBackendEnabled: false });
const tunnelSpec = Object.freeze({ binary: '/synthetic/bin/tunnel-client', version: '0.0.14', tunnelId: 'tunnel_synthetic123' });
const clock = () => {
  let wall = 10000000, mono = 5000000, id = 0;
  const timers = new Map();
  return {
    options: { wallNow: () => wall, monoNow: () => mono, setTimer: (fn, delay) => { const key = ++id; timers.set(key, { fn, at: mono + delay }); return key; }, clearTimer: key => timers.delete(key) },
    move(wallDelta, monoDelta, fire = true) { wall += wallDelta; mono += monoDelta; if (fire) for (const [key, item] of [...timers]) if (item.at <= mono) { timers.delete(key); item.fn(); } },
    timerCount: () => timers.size,
  };
};

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dots-session-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const time = clock(), calls = [], processEvents = new EventEmitter();
  let stoppedCallback;
  const service = { disable: () => calls.push('disable'), close: async () => calls.push('service-close') };
  const guard = {
    onStopped: fn => { stoppedCallback = fn; },
    prepare: async () => calls.push('guard-prepare'),
    activate: async bounds => { calls.push(['guard-activate', bounds]); },
    startTunnel: async spec => { calls.push(['tunnel-start', spec]); },
    stop: async () => calls.push('guard-stop'),
  };
  const runner = createSessionRunner({
    evidence, tunnelSpec, baseDirectory: directory, processEvents, leaseOptions: time.options,
    askSecret: async () => { calls.push('ask-secret'); return Buffer.from('synthetic-new-runtime-key'); },
    createWatchdog: async () => guard,
    startService: async config => { calls.push(['service-start', config]); return service; },
    cleanupTimeoutMs: 10,
    ...overrides,
  });
  t.after(() => runner.stop());
  return { runner, calls, time, directory, processEvents, guardStopped: reason => stoppedCallback(reason), service };
}

test('lease is dormant until first enable and activation cannot renew', () => {
  const time = clock(), lease = createHardLease(time.options);
  time.move(SESSION_MS * 20, SESSION_MS * 20);
  assert.equal(lease.snapshot().state, 'PREPARED');
  assert.equal(time.timerCount(), 0);
  const first = lease.activate();
  assert.equal(first.deadlineWallMs - first.startWallMs, SESSION_MS);
  assert.throws(() => lease.activate(), /LEASE_ACTIVATION_ONCE/u);
  assert.equal(lease.snapshot().deadlineWallMs, first.deadlineWallMs);
});

test('wall rollback cannot prolong monotonic deadline', () => {
  const time = clock(), reasons = [], lease = createHardLease({ ...time.options, onExpire: reason => reasons.push(reason) });
  lease.activate();
  time.move(-SESSION_MS * 100, SESSION_MS - 1, false);
  assert.equal(lease.check(), true);
  time.move(-SESSION_MS, 1, false);
  assert.equal(lease.check(), false);
  assert.deepEqual(reasons, ['LEASE_EXPIRED']);
});

test('wall forward, monotonic rollback and invalid clocks fail closed', () => {
  for (const [wallDelta, monoDelta, reason] of [[SESSION_MS, 0, 'LEASE_EXPIRED'], [0, -1, 'CLOCK_INVALID'], [0, NaN, 'CLOCK_INVALID']]) {
    const time = clock(), reasons = [], lease = createHardLease({ ...time.options, onExpire: value => reasons.push(value) });
    lease.activate();
    time.move(wallDelta, monoDelta, false);
    assert.equal(lease.check(), false);
    assert.deepEqual(reasons, [reason]);
  }
});

test('watchdog adopts earlier immutable deadlines rather than a fresh thirty minutes', () => {
  const time = clock(), lease = createHardLease(time.options), bounds = lease.activate();
  time.move(900, 900);
  let expiry = 0;
  const guard = createHardLease({ ...time.options, onExpire: () => expiry++ });
  const adopted = guard.activate(bounds);
  assert.equal(adopted.deadlineWallMs, bounds.deadlineWallMs);
  assert.equal(adopted.deadlineMonoMs, bounds.deadlineMonoMs);
  time.move(SESSION_MS - 900, SESSION_MS - 900);
  assert.equal(expiry, 1);
  assert.throws(() => guard.activate(bounds), /LEASE_ACTIVATION_ONCE/u);
});

test('all required evidence gates reject absent or unsuitable authority before effects', () => {
  for (const key of ['accountVerified', 'workspaceVerified', 'tunnelIdentityVerified', 'privateAccessVerified', 'newSessionTunnel']) assert.throws(() => validateEvidence({ ...evidence, [key]: false }));
  assert.throws(() => validateEvidence({ ...evidence, billingKeyProbe: true }), /BILLING_KEY_PROBE_FORBIDDEN/u);
  assert.throws(() => validateEvidence({ ...evidence, scope: 'owner-text-reply', liveBackendEnabled: true }), /TRUSTED_OWNER_AUTHORIZATION_NOT_INSTALLED/u);
  assert.throws(() => validateEvidence({ ...evidence, tunnelId: undefined }), /PRIVATE_TUNNEL_EVIDENCE_REQUIRED/u);
  assert.throws(() => validateEvidence(evidence, 'tunnel_syntheticother'), /PRIVATE_TUNNEL_EVIDENCE_REQUIRED/u);
});

test('missing account evidence does not ask for a key, create service or spawn tunnel', async t => {
  const item = fixture(t, { evidence: {} });
  await assert.rejects(item.runner.start(), /ACCOUNT_WORKSPACE_EVIDENCE_REQUIRED/u);
  assert.deepEqual(item.calls, []);
});

test('default execution and secure input adapters are absent', () => {
  assert.throws(() => createSessionRunner(), /SECURE_SECRET_INPUT_NOT_INSTALLED/u);
  assert.throws(() => createPrivateFiles(), /SECURE_SECRET_INPUT_NOT_INSTALLED/u);
});

test('explicit injected secure input writes only new private files and zeros source key', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dots-session-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const history = join(directory, 'historic-state');
  writeFileSync(history, 'synthetic-existing-state');
  const key = Buffer.from('synthetic-session-key');
  const store = createPrivateFiles({ baseDirectory: directory, askSecret: async request => { assert.equal(request.echo, false); assert.equal(request.persist, false); return key; }, random: length => Buffer.alloc(length, 8) });
  const { directory: privateDir } = await store.prepare();
  assert.equal(statSync(privateDir).mode & 0o777, 0o700);
  for (const name of ['runtime-key', 'local-token', 'empty.yaml']) assert.equal(statSync(join(privateDir, name)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(privateDir, 'runtime-key'), 'utf8'), 'synthetic-session-key');
  assert.equal(key.every(value => value === 0), true);
  store.cleanup();
  assert.equal(existsSync(privateDir), false);
  assert.equal(readFileSync(history, 'utf8'), 'synthetic-existing-state');
});

test('secret strings, newline injection and cancelled secure input fail without files', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dots-session-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const input of ['synthetic-string-key', Buffer.from('synthetic-invalid\nkey')]) {
    const store = createPrivateFiles({ baseDirectory: directory, askSecret: async () => input });
    await assert.rejects(store.prepare(), /PRIVATE_FILES_PREPARATION_FAILED/u);
  }
  const signal = AbortSignal.abort();
  const store = createPrivateFiles({ baseDirectory: directory, askSecret: async () => Buffer.from('synthetic-key-cancelled') });
  await assert.rejects(store.prepare({ signal }), /SESSION_STOPPED/u);
});

test('both exact supported versions use secret file references, loopback endpoints and explicit empty config', () => {
  for (const version of ['0.0.14', '0.0.15']) {
    const spec = tunnelCommand({ ...tunnelSpec, version, privateDir: '/tmp/dots-wechat-session-synthetic' });
    assert.deepEqual(spec.args, ['run', '--config', '/tmp/dots-wechat-session-synthetic/empty.yaml', '--control-plane.tunnel-id', 'tunnel_synthetic123', '--control-plane.api-key', 'file:/tmp/dots-wechat-session-synthetic/runtime-key', '--mcp.server-url', 'http://127.0.0.1:8890/mcp', '--mcp.extra-headers', 'X-Dots-Local-Token: file:/tmp/dots-wechat-session-synthetic/local-token', '--health.listen-addr', '127.0.0.1:0']);
    assert.equal(spec.args.some(arg => /cloudflared|0\.0\.0\.0|runtimes|profile/u.test(arg)), false);
  }
  assert.throws(() => tunnelCommand({ ...tunnelSpec, version: 'unknown', privateDir: '/tmp/new' }), /VERIFIED_BINARY_REQUIRED/u);
});

test('environment whitelist excludes existing keys, cookies, proxy, profiles and execution hooks', () => {
  const source = { PATH: '/synthetic/bin', HOME: '/synthetic/home', TMPDIR: '/tmp', LANG: 'C', CONTROL_PLANE_API_KEY: 'synthetic-old-key', OPENAI_API_KEY: 'synthetic-old-key', TUNNEL_CLIENT_PROFILE: 'historic', COOKIE: 'synthetic-cookie', NODE_OPTIONS: '--import malicious', HTTPS_PROXY: 'https://synthetic-proxy' };
  assert.deepEqual(sanitizedEnvironment(source), { PATH: source.PATH, HOME: source.HOME, TMPDIR: '/tmp', LANG: 'C' });
});

test('guard activates before service; service and header cannot authorize owner effects', async t => {
  const item = fixture(t);
  const result = await item.runner.start();
  assert.equal(result.state, 'ACTIVE');
  const names = item.calls.map(entry => Array.isArray(entry) ? entry[0] : entry);
  assert.deepEqual(names, ['ask-secret', 'guard-prepare', 'guard-activate', 'service-start', 'tunnel-start']);
  const config = item.calls.find(entry => entry[0] === 'service-start')[1];
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8890);
  assert.equal(config.backendMode, 'disabled');
  assert.equal(config.localHeaderIsOwnerAuthority, false);
  assert.throws(() => item.runner.assertEffectsAllowed(), /TRUSTED_OWNER_AUTHORIZATION_NOT_INSTALLED/u);
  await assert.rejects(item.runner.start(), /SESSION_START_ONCE/u);
});

for (const signal of ['SIGINT', 'SIGTERM', 'disconnect', 'parentShutdown']) test(`${signal} immediately disables service, aborts operations and stops tunnel`, async t => {
  const item = fixture(t);
  await item.runner.start();
  const config = item.calls.find(entry => entry[0] === 'service-start')[1];
  const privateDir = item.calls.find(entry => entry[0] === 'tunnel-start')[1].privateDir;
  item.processEvents.emit(signal);
  assert.equal(item.runner.snapshot().state, 'STOPPED');
  assert.equal(config.signal.aborted, true);
  assert.equal(item.calls.includes('disable'), true);
  await item.runner.stop();
  assert.equal(item.calls.includes('guard-stop'), true);
  assert.equal(existsSync(privateDir), false);
});

test('lease expiry independently disables effects while parent waits indefinitely', async t => {
  const item = fixture(t, { startService: async config => ({ disable: () => { item.calls.push('disable'); assert.equal(config.signal.aborted, true); }, close: () => new Promise(() => {}) }) });
  await item.runner.start();
  item.time.move(-SESSION_MS * 9, SESSION_MS);
  assert.equal(item.runner.snapshot().state, 'STOPPED');
  assert.equal(item.calls.includes('disable'), true);
  await item.runner.stop();
  assert.equal(item.calls.includes('guard-stop'), true);
});

test('service that resolves after parent shutdown is disabled and closed before tunnel start', async t => {
  let finish;
  const item = fixture(t, { startService: () => new Promise(resolve => { finish = resolve; }) });
  const starting = item.runner.start();
  for (let count = 0; count < 10 && !finish; count++) await Promise.resolve();
  assert.equal(typeof finish, 'function');
  await item.runner.stop();
  finish(item.service);
  await assert.rejects(starting, /SESSION_START_FAILED/u);
  await Promise.resolve();
  assert.equal(item.calls.includes('disable'), true);
  assert.equal(item.calls.includes('service-close'), true);
  assert.equal(item.calls.some(entry => entry[0] === 'tunnel-start'), false);
});

test('watchdog shutdown immediately kills its tunnel and own runner without awaiting parent', () => {
  const time = clock(), calls = [], child = new EventEmitter();
  child.kill = signal => calls.push(['kill-tunnel', signal]);
  const guard = createWatchdogCore({ spawnChild: (command, args, options) => { calls.push(['spawn', command, args, options]); return child; }, killRunner: () => calls.push('kill-runner'), cleanup: () => calls.push('cleanup-new-files'), leaseOptions: time.options, setRepeater: () => 1, clearRepeater: () => calls.push('clear-repeater') });
  guard.activate();
  guard.startTunnel({ ...tunnelSpec, privateDir: '/tmp/dots-wechat-session-synthetic' }, { CONTROL_PLANE_API_KEY: 'synthetic-old-key', PATH: '/synthetic/bin' });
  time.move(-SESSION_MS * 5, SESSION_MS);
  assert.equal(guard.snapshot().stopped, true);
  assert.deepEqual(calls.slice(1), ['clear-repeater', ['kill-tunnel', 'SIGKILL'], 'kill-runner', 'cleanup-new-files']);
  assert.equal(calls[0][3].shell, false);
  assert.deepEqual(calls[0][3].env, { PATH: '/synthetic/bin' });
  assert.throws(() => guard.startTunnel({ ...tunnelSpec, privateDir: '/tmp/new' }, {}), /TUNNEL_START_REJECTED/u);
});

test('watchdog parent disconnect and unexpected tunnel exit close owned resources once', () => {
  for (const kind of ['disconnect', 'exit', 'error']) {
    const time = clock(), calls = [], child = new EventEmitter();
    child.kill = signal => calls.push(signal);
    const guard = createWatchdogCore({ spawnChild: () => child, killRunner: () => calls.push('runner'), cleanup: () => calls.push('cleanup'), leaseOptions: time.options, setRepeater: () => 1, clearRepeater: () => {} });
    guard.activate();
    guard.startTunnel({ ...tunnelSpec, privateDir: '/tmp/dots-wechat-session-synthetic' });
    if (kind === 'disconnect') guard.stop('PARENT_DISCONNECT');
    else child.emit(kind, kind === 'exit' ? 1 : new Error('synthetic'));
    guard.stop('SECOND_STOP');
    assert.deepEqual(calls, kind === 'disconnect' ? ['SIGKILL', 'cleanup'] : ['SIGKILL', 'runner', 'cleanup']);
  }
});

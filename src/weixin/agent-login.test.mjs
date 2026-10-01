import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runCli } from './cli.mjs';
import { createWeixinQrBinding } from './binding.mjs';

const qr = { qrcode: 'fictional-session-secret', qrcode_img_content: 'https://example.invalid/fictional-qr-secret' };
const confirmed = { status: 'confirmed', bot_token: 'fictional-new-token-never-live', ilink_bot_id: 'fictional-bot', ilink_user_id: 'fictional-owner', baseurl: 'https://ilinkai.weixin.qq.com' };
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const scope = ['--agent-confirmed-consent', '--agent-consent-scope', 'new-binding,owner-scan,local-credentials'];
const args = dir => ['login', '--state-dir', dir, ...scope];
async function temp(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dots-wechat-agent-test-')));
  await fs.chmod(parent, 0o700);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, stateDir: path.join(parent, 'new-binding') };
}
function harness(extra = {}) {
  const output = [];
  const errors = [];
  const signalSource = new EventEmitter();
  const io = {
    isTerminal: false, signalSource, wallNow: Date.now,
    write: value => output.push(value), error: value => errors.push(value),
    ask: async () => { assert.fail('Agent mode must not prompt'); },
    pause: async () => {}, renderQr: async (payload, filename) => {
      assert.equal(payload, qr.qrcode_img_content);
      await fs.writeFile(filename, 'synthetic-png-fixture', { mode: 0o600 });
    },
    fetchImpl: async () => { assert.fail('Unexpected fictional transport request'); },
    ...extra,
  };
  return { io, output, errors, signalSource };
}
const last = values => JSON.parse(values.at(-1));

test('non-TTY login requires both agent scope and explicit technical flag before any QR request', async t => {
  const { stateDir } = await temp(t);
  const h = harness();
  for (const suffix of [[], ['--agent-confirmed-consent'], ['--agent-consent-scope', 'new-binding,owner-scan,local-credentials'], ['--agent-confirmed-consent', '--agent-consent-scope', 'login']]) {
    assert.equal(await runCli(['login', '--state-dir', stateDir, ...suffix], h.io), 1);
    assert.equal(last(h.errors).code, suffix.length ? 'AGENT_CONSENT_SCOPE_REQUIRED' : 'INTERACTIVE_TERMINAL_REQUIRED');
  }
  assert.equal(h.output.length, 0);
});

test('agent mode requires a canonical absolute path and private parent; it does not create parents', async t => {
  const { parent, stateDir } = await temp(t);
  const h = harness();
  assert.equal(await runCli(args('relative-leaf'), h.io), 1);
  assert.equal(last(h.errors).code, 'AGENT_ABSOLUTE_STATE_DIR_REQUIRED');
  await fs.chmod(parent, 0o755);
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'STATE_DIRECTORY_INSECURE');
  await fs.chmod(parent, 0o700);
  const link = path.join(parent, 'link');
  await fs.symlink(parent, link);
  assert.equal(await runCli(args(path.join(link, 'leaf')), h.io), 1);
  assert.equal(last(h.errors).code, 'STATE_DIRECTORY_INSECURE');
  assert.equal(await runCli(args(path.join(parent, 'missing-parent', 'leaf')), h.io), 1);
});

test('existing credentials or empty leaf are never overwritten or imported', async t => {
  const { stateDir } = await temp(t);
  await fs.mkdir(stateDir, { mode: 0o700 });
  const h = harness();
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'STATE_DIR_ALREADY_EXISTS');
  await fs.writeFile(path.join(stateDir, 'credentials.json'), 'fictional-existing-not-read', { mode: 0o600 });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(await fs.readFile(path.join(stateDir, 'credentials.json'), 'utf8'), 'fictional-existing-not-read');
});

test('QR_READY is emitted before the same process polls, and the private PNG remains available until scan confirmation', async t => {
  const { stateDir } = await temp(t);
  let qrPath;
  let calls = 0;
  let releasePoll;
  let pollStarted;
  const observedPoll = new Promise(resolve => { pollStarted = resolve; });
  const gate = new Promise(resolve => { releasePoll = resolve; });
  const h = harness({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(init.headers.Authorization, undefined);
    if (calls === 1) {
      assert.deepEqual(JSON.parse(init.body), { local_token_list: [] });
      return response(qr);
    }
    const ready = last(h.output);
    assert.equal(ready.status, 'QR_READY');
    qrPath = ready.qrPngPath;
    assert.ok(path.isAbsolute(qrPath));
    assert.ok(Number.isSafeInteger(ready.generatedAtMs));
    assert.ok(ready.generatedAtMs <= ready.localWaitDeadlineMs);
    assert.equal(ready.privateArtifact, true);
    assert.equal(ready.providerExpiryKnown, false);
    assert.equal((await fs.stat(qrPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(qrPath))).mode & 0o777, 0o700);
    pollStarted();
    await gate;
    return response(confirmed);
  } });
  const running = runCli(args(stateDir), h.io);
  await observedPoll;
  assert.equal(h.output.length, 1);
  assert.equal(await fs.readFile(qrPath, 'utf8'), 'synthetic-png-fixture');
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
  releasePoll();
  assert.equal(await running, 0);
  assert.equal(last(h.output).status, 'BOUND');
  assert.equal(calls, 2);
  assert.equal((await fs.stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(stateDir, 'credentials.json'))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(qrPath), { code: 'ENOENT' });
  const emitted = h.output.join('') + h.errors.join('');
  for (const secret of [qr.qrcode, qr.qrcode_img_content, confirmed.bot_token, confirmed.ilink_user_id, confirmed.ilink_bot_id]) assert.equal(emitted.includes(secret), false);
  assert.equal(emitted.includes('file://'), false);
  assert.equal(h.signalSource.listenerCount('SIGINT'), 0);
});

for (const status of ['expired', 'verify_code_blocked', 'need_verifycode']) test(`provider ${status} stops without QR refresh and cleans the private artifact`, async t => {
  const { stateDir } = await temp(t);
  let calls = 0;
  const h = harness({ fetchImpl: async () => response(++calls === 1 ? qr : { status }) });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(calls, 2);
  assert.equal(last(h.errors).code, status === 'need_verifycode' ? 'AGENT_VERIFICATION_CODE_UNSUPPORTED' : 'BINDING_EXPIRED_RESTART_WITH_NEW_CONSENT');
  await assert.rejects(fs.stat(last(h.output).qrPngPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} aborts a poll even if transport ignores AbortSignal, and cleans the private artifact`, async t => {
  const { stateDir } = await temp(t);
  let calls = 0;
  const h = harness({ fetchImpl: async () => {
    if (++calls === 1) return response(qr);
    queueMicrotask(() => h.signalSource.emit(signal));
    return await new Promise(() => {});
  } });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'BINDING_INTERRUPTED');
  await assert.rejects(fs.stat(last(h.output).qrPngPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
  assert.equal(h.signalSource.listenerCount(signal), 0);
});

test('changing private parent identity before confirmation refuses persistence', async t => {
  const { parent, stateDir } = await temp(t);
  const movedParent = `${parent}-moved`;
  t.after(() => fs.rm(movedParent, { recursive: true, force: true }));
  let calls = 0;
  const h = harness({ fetchImpl: async () => {
    if (++calls === 1) return response(qr);
    await fs.rename(parent, movedParent);
    await fs.mkdir(parent, { mode: 0o700 });
    return response(confirmed);
  } });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'STATE_DIRECTORY_CHANGED');
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(last(h.output).qrPngPath), { code: 'ENOENT' });
});

test('local waiting limit expires without treating it as known provider QR expiry or refreshing QR', async t => {
  const { stateDir } = await temp(t);
  let now = 1000;
  let calls = 0;
  const h = harness({ wallNow: () => now, pause: async () => { now += 300001; }, fetchImpl: async () => response(++calls === 1 ? qr : { status: 'wait' }) });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'LOCAL_BINDING_DEADLINE');
  assert.equal(calls, 2);
  assert.equal(last(h.output).providerExpiryKnown, false);
  await assert.rejects(fs.stat(last(h.output).qrPngPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});

test('insecure PNG is rejected before QR_READY metadata or polling', async t => {
  const { stateDir } = await temp(t);
  let qrPath;
  const h = harness({ fetchImpl: async () => response(qr), renderQr: async (payload, filename) => {
    qrPath = filename;
    await fs.writeFile(filename, 'synthetic-png-fixture', { mode: 0o644 });
  } });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'QR_ARTIFACT_INSECURE');
  assert.equal(h.output.length, 0);
  await assert.rejects(fs.stat(qrPath), { code: 'ENOENT' });
});

test('ordinary TTY flow retains typed consent and local file URL', async t => {
  const { stateDir } = await temp(t);
  let calls = 0;
  let prompts = 0;
  const h = harness({ isTerminal: true, ask: async () => { prompts++; return 'BIND MY WECHAT'; }, fetchImpl: async () => response(++calls === 1 ? qr : confirmed) });
  assert.equal(await runCli(['login', '--state-dir', stateDir], h.io), 0);
  assert.equal(prompts, 1);
  assert.ok(h.output[0].includes('file://'));
  assert.equal(last(h.output).status, 'BOUND');
});

test('local timer aborts a pending poll with an explicit local deadline diagnostic', async t => {
  const { stateDir } = await temp(t);
  let calls = 0;
  const h = harness({
    createBinding: options => {
      const binding = createWeixinQrBinding(options);
      return { ...binding, requestQrOnce: async () => ({ ...await binding.requestQrOnce(), expiresAtMs: Date.now() + 100 }) };
    },
    fetchImpl: async () => ++calls === 1 ? response(qr) : new Promise(() => {}),
  });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'LOCAL_BINDING_DEADLINE');
  assert.equal(calls, 2);
  await assert.rejects(fs.stat(last(h.output).qrPngPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});

test('QR render passing the local deadline is cleaned without emitting QR_READY', async t => {
  const { stateDir } = await temp(t);
  let now = 1000;
  let qrPath;
  let calls = 0;
  const h = harness({ wallNow: () => now, fetchImpl: async () => { calls++; return response(qr); }, renderQr: async (payload, filename) => {
    qrPath = filename;
    await fs.writeFile(filename, 'synthetic-png-fixture', { mode: 0o600 });
    now += 300000;
  } });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'LOCAL_BINDING_DEADLINE');
  assert.equal(calls, 1);
  assert.equal(h.output.length, 0);
  await assert.rejects(fs.stat(qrPath), { code: 'ENOENT' });
});

for (const stage of ['request', 'render']) test(`signal during ${stage} is diagnosed as interruption before QR_READY`, async t => {
  const { stateDir } = await temp(t);
  let qrPath;
  const h = harness({ fetchImpl: async () => {
    if (stage === 'request') {
      queueMicrotask(() => h.signalSource.emit('SIGINT'));
      return await new Promise(() => {});
    }
    return response(qr);
  }, renderQr: async (payload, filename) => {
    qrPath = filename;
    await fs.writeFile(filename, 'synthetic-png-fixture', { mode: 0o600 });
    h.signalSource.emit('SIGTERM');
  } });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'BINDING_INTERRUPTED');
  assert.equal(h.output.length, 0);
  if (qrPath) await assert.rejects(fs.stat(qrPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
  assert.equal(h.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(h.signalSource.listenerCount('SIGTERM'), 0);
});

test('genuine transport failure retains provider diagnostic rather than cancellation', async t => {
  const { stateDir } = await temp(t);
  const h = harness({ fetchImpl: async () => { throw new Error('fictional transport loss'); } });
  assert.equal(await runCli(args(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'PROVIDER_REQUEST_FAILED');
  assert.equal(h.output.length, 0);
});

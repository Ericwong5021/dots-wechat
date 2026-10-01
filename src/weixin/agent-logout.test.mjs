import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runCli, CLI_USAGE } from './cli.mjs';
import { createPrivateStateStore } from './private-state-store.mjs';

const credential = { schemaVersion: 1, provider: 'tencent-weixin-ilink', baseUrl: 'https://ilinkai.weixin.qq.com', botToken: 'fictional-logout-token', botId: 'fictional-logout-bot', ownerUserId: 'fictional-logout-owner', createdAtMs: 1000 };
const consent = ['--agent-confirmed-consent', '--agent-consent-scope', 'local-credentials,local-verify-state'];
const argv = stateDir => ['logout', '--state-dir', stateDir, ...consent];
const last = values => JSON.parse(values.at(-1));
async function fixture(t, withState = true) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dots-wechat-agent-logout-synthetic-')));
  await fs.chmod(parent, 0o700);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const stateDir = path.join(parent, 'fictional-binding');
  await fs.mkdir(stateDir, { mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'credentials.json'), JSON.stringify(credential), { mode: 0o600 });
  if (withState) await fs.writeFile(path.join(stateDir, 'verify-state.json'), 'fictional-dedup-state-not-read', { mode: 0o600 });
  return { parent, stateDir };
}
function harness(extra = {}) {
  const output = [];
  const errors = [];
  const signalSource = new EventEmitter();
  return { output, errors, signalSource, io: {
    isTerminal: false, signalSource,
    write: value => output.push(value), error: value => errors.push(value),
    ask: async () => assert.fail('Agent logout must not prompt'),
    fetchImpl: async () => assert.fail('No network is authorized by local logout'),
    createClient: () => assert.fail('No message client during logout'),
    createBinding: () => assert.fail('No new binding during logout'),
    ...extra,
  } };
}
async function preserved(stateDir) {
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'credentials.json'), 'utf8')), credential);
  assert.equal(await fs.readFile(path.join(stateDir, 'verify-state.json'), 'utf8'), 'fictional-dedup-state-not-read');
}
function noSecrets(h, stateDir) {
  const emitted = h.output.join('') + h.errors.join('');
  for (const secret of [credential.botToken, credential.botId, credential.ownerUserId, stateDir, 'fictional-dedup-state-not-read']) assert.equal(emitted.includes(secret), false);
  assert.equal(h.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(h.signalSource.listenerCount('SIGTERM'), 0);
}

test('unapproved non-TTY invocation stops before filesystem or injected state-store access', async () => {
  const h = harness({ createStateStore: () => assert.fail('No state mutation before declaration') });
  for (const [suffix, code] of [
    [[], 'INTERACTIVE_TERMINAL_REQUIRED'],
    [['--agent-confirmed-consent'], 'AGENT_CONSENT_SCOPE_REQUIRED'],
    [['--agent-consent-scope', 'local-credentials,local-verify-state'], 'AGENT_CONSENT_SCOPE_REQUIRED'],
  ]) {
    assert.equal(await runCli(['logout', '--state-dir', '/fictional-nonexistent-do-not-open', ...suffix], h.io), 1);
    assert.equal(last(h.errors).code, code);
  }
  assert.equal(h.output.length, 0);
});

test('logout rejects login scope, partial, reordered, extended, repeated and remote scopes', async t => {
  const { stateDir } = await fixture(t);
  const h = harness();
  for (const scope of ['new-binding,owner-scan,local-credentials', 'local-credentials', 'local-verify-state,local-credentials', 'local-credentials,local-verify-state,history', 'local-credentials,local-verify-state,local-verify-state', 'revoke-remote-binding,local-credentials,local-verify-state', 'local-credentials, local-verify-state']) {
    assert.equal(await runCli(['logout', '--state-dir', stateDir, '--agent-confirmed-consent', '--agent-consent-scope', scope], h.io), 1);
    assert.equal(last(h.errors).code, 'AGENT_CONSENT_SCOPE_REQUIRED');
  }
  assert.equal(await runCli([...argv(stateDir), '--agent-confirmed-consent'], h.io), 1);
  assert.equal(last(h.errors).code, 'INVALID_ARGUMENTS');
  for (const command of ['status', 'verify']) {
    assert.equal(await runCli([command, '--state-dir', stateDir, ...consent], h.io), 1);
    assert.equal(last(h.errors).code, 'INVALID_ARGUMENTS');
  }
  assert.equal(await runCli(['login', '--state-dir', stateDir, ...consent], h.io), 1);
  assert.equal(last(h.errors).code, 'AGENT_CONSENT_SCOPE_REQUIRED');
  await preserved(stateDir);
  noSecrets(h, stateDir);
});

for (const withState of [true, false]) test(`agent local logout succeeds with verify state ${withState ? 'present' : 'absent'}, reports no remote attempt`, async t => {
  const { parent, stateDir } = await fixture(t, withState);
  const other = path.join(parent, 'unrelated-history');
  await fs.writeFile(other, 'fictional-other-state');
  const h = harness();
  assert.equal(await runCli(argv(stateDir), h.io), 0);
  assert.deepEqual(last(h.output), { status: 'LOCAL_LOGOUT', localCredentialsDeleted: true, localVerifyStateDeleted: withState, localVerifyStateAbsent: !withState, directoryRemoved: true, remoteRevocation: 'NOT_ATTEMPTED', remoteRevocationConfirmed: false });
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
  assert.equal(await fs.readFile(other, 'utf8'), 'fictional-other-state');
  assert.equal(h.errors.length, 0);
  noSecrets(h, stateDir);
});

test('agent mode applies the same scope on TTY without prompting', async t => {
  const { stateDir } = await fixture(t);
  const h = harness({ isTerminal: true });
  assert.equal(await runCli(argv(stateDir), h.io), 0);
  assert.equal(last(h.output).status, 'LOCAL_LOGOUT');
});

test('ordinary TTY retains typed confirmation and legacy local-only response', async t => {
  const { stateDir } = await fixture(t);
  let prompts = 0;
  const h = harness({ isTerminal: true, ask: async text => {
    prompts++;
    assert.ok(text.includes('DELETE LOCAL DOTS WECHAT'));
    return prompts === 1 ? 'no' : 'DELETE LOCAL DOTS WECHAT';
  } });
  assert.equal(await runCli(['logout', '--state-dir', stateDir], h.io), 1);
  assert.equal(last(h.errors).code, 'CONSENT_NOT_GIVEN');
  await preserved(stateDir);
  assert.equal(await runCli(['logout', '--state-dir', stateDir], h.io), 0);
  assert.deepEqual(last(h.output), { status: 'LOCAL_CREDENTIALS_DELETED', remoteUnbinding: false });
  assert.equal(prompts, 2);
});

test('agent path must be canonical and absolute; forbidden directories remain forbidden', async t => {
  const { stateDir } = await fixture(t);
  const h = harness();
  for (const invalid of ['fictional-relative', `${stateDir}/../fictional-binding`, `${stateDir}/`]) {
    assert.equal(await runCli(argv(invalid), h.io), 1);
    assert.equal(last(h.errors).code, 'AGENT_ABSOLUTE_STATE_DIR_REQUIRED');
  }
  for (const invalid of ['/', '/tmp/.openclaw/fictional', '/tmp/.hermes/fictional', '/tmp/fictional\nstate']) {
    assert.equal(await runCli(argv(invalid), h.io), 1);
    assert.equal(last(h.errors).code, 'STATE_DIR_FORBIDDEN');
  }
  await preserved(stateDir);
});

test('unknown files, gateway state and active lock refuse all local deletion', async t => {
  const { stateDir } = await fixture(t);
  const h = harness({ createStateStore: () => assert.fail('Preflight rejects before acquiring a new lock') });
  for (const name of ['unrelated-history.json', 'gateway-state.json', 'verify-state.json.lock']) {
    const filename = path.join(stateDir, name);
    await fs.writeFile(filename, 'fictional-do-not-read-or-delete', { mode: 0o600 });
    assert.equal(await runCli(argv(stateDir), h.io), 1);
    assert.equal(last(h.errors).code, name.endsWith('.lock') ? 'STATE_LOCKED' : 'UNRECOGNIZED_STATE_FILES');
    assert.equal(await fs.readFile(filename, 'utf8'), 'fictional-do-not-read-or-delete');
    await preserved(stateDir);
    await fs.unlink(filename);
  }
  assert.equal(h.output.length, 0);
});

test('directory symlinks and permissive ownership modes are rejected', async t => {
  const { parent, stateDir } = await fixture(t);
  const h = harness();
  await fs.symlink(stateDir, path.join(parent, 'alias'));
  assert.equal(await runCli(argv(path.join(parent, 'alias')), h.io), 1);
  assert.equal(last(h.errors).code, 'STATE_DIRECTORY_INSECURE');
  await fs.chmod(stateDir, 0o755);
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'STATE_DIRECTORY_INSECURE');
  await fs.chmod(stateDir, 0o700);
  await preserved(stateDir);
});

test('injected effective UID mismatch refuses deletion without changing ownership', async t => {
  const { stateDir } = await fixture(t);
  const h = harness();
  const getuid = process.geteuid;
  try {
    process.geteuid = () => getuid() + 1;
    assert.equal(await runCli(argv(stateDir), h.io), 1);
    assert.equal(last(h.errors).code, 'STATE_DIRECTORY_INSECURE');
  } finally { process.geteuid = getuid; }
  await preserved(stateDir);
});

for (const kind of ['symlink', 'hardlink', 'mode']) test(`insecure verify file ${kind} is refused without deletion`, async t => {
  const { parent, stateDir } = await fixture(t);
  const filename = path.join(stateDir, 'verify-state.json');
  const h = harness();
  if (kind === 'mode') await fs.chmod(filename, 0o644);
  else {
    const outside = path.join(parent, 'protected-synthetic-state');
    await fs.writeFile(outside, 'fictional-external', { mode: 0o600 });
    await fs.unlink(filename);
    await (kind === 'symlink' ? fs.symlink(outside, filename) : fs.link(outside, filename));
  }
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'LOCAL_FILE_INSECURE');
  await fs.access(path.join(stateDir, 'credentials.json'));
  await fs.lstat(filename);
  assert.equal(h.output.length, 0);
});

test('invalid or insecure credential refuses agent cleanup without leakage', async t => {
  const { stateDir } = await fixture(t);
  const filename = path.join(stateDir, 'credentials.json');
  const h = harness();
  await fs.writeFile(filename, JSON.stringify({ ...credential, botToken: '' }));
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'CREDENTIAL_INVALID');
  await fs.writeFile(filename, JSON.stringify(credential));
  await fs.chmod(filename, 0o644);
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'CREDENTIAL_INSECURE');
  await preserved(stateDir);
  noSecrets(h, stateDir);
});

test('directory replacement after lock acquisition preserves both original and replacement state', async t => {
  const { stateDir } = await fixture(t);
  const moved = `${stateDir}-moved`;
  const h = harness({ createStateStore: async options => {
    const store = await createPrivateStateStore(options);
    await fs.rename(stateDir, moved);
    await fs.mkdir(stateDir, { mode: 0o700 });
    await fs.writeFile(path.join(stateDir, 'credentials.json'), JSON.stringify(credential), { mode: 0o600 });
    return store;
  } });
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'STATE_DIRECTORY_CHANGED');
  await preserved(moved);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'credentials.json'), 'utf8')), credential);
  assert.equal(h.output.length, 0);
  noSecrets(h, stateDir);
});

for (const mutation of ['replace', 'add-verify', 'add-unknown']) test(`post-lock ${mutation} is rejected before credential deletion`, async t => {
  const { stateDir } = await fixture(t, mutation !== 'add-verify');
  const h = harness({ createStateStore: async options => {
    const store = await createPrivateStateStore(options);
    if (mutation === 'replace') {
      await fs.rename(path.join(stateDir, 'credentials.json'), path.join(stateDir, 'saved-credentials'));
      await fs.writeFile(path.join(stateDir, 'credentials.json'), JSON.stringify(credential), { mode: 0o600 });
      await fs.unlink(path.join(stateDir, 'saved-credentials'));
    } else await fs.writeFile(path.join(stateDir, mutation === 'add-verify' ? 'verify-state.json' : 'new-history.json'), 'fictional-not-approved', { mode: 0o600 });
    return store;
  } });
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, mutation === 'add-unknown' ? 'UNRECOGNIZED_STATE_FILES' : 'LOCAL_FILE_CHANGED');
  await fs.access(path.join(stateDir, 'credentials.json'));
  assert.equal(h.output.length, 0);
  await assert.rejects(fs.stat(path.join(stateDir, 'verify-state.json.lock')), { code: 'ENOENT' });
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} before deletion preserves local files and releases lock`, async t => {
  const { stateDir } = await fixture(t);
  const h = harness({ createStateStore: async options => {
    const store = await createPrivateStateStore(options);
    h.signalSource.emit(signal);
    return store;
  } });
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, 'LOGOUT_INTERRUPTED');
  await preserved(stateDir);
  await assert.rejects(fs.stat(path.join(stateDir, 'verify-state.json.lock')), { code: 'ENOENT' });
  assert.equal(h.output.length, 0);
  noSecrets(h, stateDir);
});

test('cleanup failure after deletion reports local UNKNOWN with confirmed facts, never remote success', async t => {
  const { stateDir } = await fixture(t);
  const h = harness({ createStateStore: async options => {
    const store = await createPrivateStateStore(options);
    return { close: async () => { await store.close(); throw new Error('fictional-token-and-private-response-must-not-leak'); } };
  } });
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.deepEqual(last(h.output), { status: 'LOCAL_LOGOUT_UNKNOWN', localCredentialsDeleted: true, localVerifyStateDeleted: true, localVerifyStateAbsent: false, directoryRemoved: false, remoteRevocation: 'NOT_ATTEMPTED', remoteRevocationConfirmed: false });
  assert.equal(last(h.errors).code, 'CLI_OPERATION_FAILED');
  assert.equal((h.output.join('') + h.errors.join('')).includes('private-response'), false);
  assert.equal((await fs.readdir(stateDir)).length, 0);
  noSecrets(h, stateDir);
});

for (const completion of ['new-file', 'signal']) test(`post-deletion ${completion} reports UNKNOWN and preserves remaining directory contents`, async t => {
  const { stateDir } = await fixture(t);
  const h = harness({ createStateStore: async options => {
    const store = await createPrivateStateStore(options);
    return { close: async () => {
      await store.close();
      if (completion === 'new-file') await fs.writeFile(path.join(stateDir, 'new-unapproved-history'), 'fictional-preserve', { mode: 0o600 });
      else h.signalSource.emit('SIGTERM');
    } };
  } });
  assert.equal(await runCli(argv(stateDir), h.io), 1);
  assert.equal(last(h.errors).code, completion === 'new-file' ? 'UNRECOGNIZED_STATE_FILES' : 'LOGOUT_INTERRUPTED');
  assert.equal(last(h.output).status, 'LOCAL_LOGOUT_UNKNOWN');
  assert.equal(last(h.output).localCredentialsDeleted, true);
  assert.equal(last(h.output).remoteRevocation, 'NOT_ATTEMPTED');
  assert.equal(last(h.output).directoryRemoved, false);
  if (completion === 'new-file') assert.equal(await fs.readFile(path.join(stateDir, 'new-unapproved-history'), 'utf8'), 'fictional-preserve');
  noSecrets(h, stateDir);
});

test('help declares exact logout scope and separates technical flags from remote revocation', () => {
  assert.ok(CLI_USAGE.includes('--agent-consent-scope local-credentials,local-verify-state'));
  assert.ok(CLI_USAGE.includes('not cryptographic owner proof or user consent'));
  assert.ok(CLI_USAGE.includes('Remote revocation is not attempted or confirmed'));
});

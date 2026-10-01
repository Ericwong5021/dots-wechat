import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { runCli } from './cli.mjs';

const credential = { schemaVersion: 1, provider: 'tencent-weixin-ilink', baseUrl: 'https://ilinkai.weixin.qq.com', botToken: 'fictional-token-never-live', botId: 'fictional-bot@im.bot', ownerUserId: 'fictional-owner@im.wechat', createdAtMs: 1000 };
const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const inbound = (id, text = 'challenge', owner = credential.ownerUserId) => ({ message_id: id, from_user_id: owner, to_user_id: credential.botId, message_type: 1, message_state: 2, context_token: `fictional-context-${id}`, item_list: [{ type: 1, text_item: { text } }] });

async function temp(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dots-wechat-cli-test-')));
  await fs.chmod(parent, 0o700);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, stateDir: path.join(parent, 'account') };
}
async function bound(t) {
  const paths = await temp(t);
  await fs.mkdir(paths.stateDir, { mode: 0o700 });
  await fs.writeFile(path.join(paths.stateDir, 'credentials.json'), JSON.stringify(credential), { mode: 0o600 });
  return paths;
}
function harness(extra = {}) {
  const output = [];
  const errors = [];
  return { output, errors, io: { write: value => output.push(value), error: value => errors.push(value), isTerminal: false, signalSource: new EventEmitter(), fetchImpl: () => { throw new Error('Unexpected test network transport'); }, ...extra } };
}
function result(h) { return JSON.parse(h.output.at(-1)); }
function error(h) { return JSON.parse(h.errors.at(-1)); }

test('invalid or missing parameters fail before transport, with redacted errors', async () => {
  const h = harness();
  assert.equal(await runCli(['verify', '--state-dir', '/unused', '--expect', 'x', '--max-polls', '11'], h.io), 1);
  assert.equal(error(h).code, 'INVALID_BOUND');
  assert.equal(await runCli(['login', '--state-dir', '/unused'], h.io), 1);
  assert.equal(error(h).code, 'INTERACTIVE_TERMINAL_REQUIRED');
  assert.equal(await runCli(['status', '--state-dir', '/tmp/.openclaw/account'], h.io), 1);
  assert.equal(error(h).code, 'STATE_DIR_FORBIDDEN');
});

test('status is offline and does not reveal fictional credential IDs or tokens', async t => {
  const { stateDir } = await bound(t);
  const h = harness();
  assert.equal(await runCli(['status', '--state-dir', stateDir], h.io), 0);
  assert.equal(result(h).status, 'LOCALLY_BOUND');
  assert.equal(result(h).networkChecked, false);
  for (const secret of [credential.botToken, credential.botId, credential.ownerUserId, stateDir]) assert.equal(h.output.join('').includes(secret), false);
  await fs.chmod(path.join(stateDir, 'credentials.json'), 0o644);
  assert.equal(await runCli(['status', '--state-dir', stateDir], h.io), 1);
  assert.equal(error(h).code, 'CREDENTIAL_INSECURE');
});

test('status rejects numeric owner or bot IDs rather than coercing them to strings', async t => {
  const { stateDir } = await bound(t);
  const filename = path.join(stateDir, 'credentials.json');
  const h = harness();
  for (const key of ['ownerUserId', 'botId']) {
    await fs.writeFile(filename, JSON.stringify({ ...credential, [key]: 123 }));
    assert.equal(await runCli(['status', '--state-dir', stateDir], h.io), 1);
    assert.equal(error(h).code, 'CREDENTIAL_INVALID');
    assert.equal(h.output.length, 0);
  }
});

test('login refuses an existing directory before consent or QR requests', async t => {
  const { stateDir } = await bound(t);
  const h = harness({ isTerminal: true, ask: () => { assert.fail('No consent required for rejected directory'); } });
  assert.equal(await runCli(['login', '--state-dir', stateDir], h.io), 1);
  assert.equal(error(h).code, 'STATE_DIR_ALREADY_EXISTS');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'credentials.json'), 'utf8')), credential);
});

test('login uses real binding code with fictional provider responses; consent, fresh-token and QR cleanup are enforced', async t => {
  const { stateDir } = await temp(t);
  let calls = 0;
  let qrPath;
  const h = harness({ isTerminal: true, ask: async () => 'BIND MY WECHAT', pause: async () => {}, renderQr: async (payload, filename) => {
    assert.equal(payload, 'fictional-qr-payload');
    qrPath = filename;
    await fs.writeFile(filename, 'fictional-png', { mode: 0o600 });
    assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
  }, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(init.headers.Authorization, undefined);
    if (calls === 1) { assert.deepEqual(JSON.parse(init.body), { local_token_list: [] }); return response({ qrcode: 'fictional-qr-id', qrcode_img_content: 'fictional-qr-payload' }); }
    return response({ status: 'confirmed', bot_token: credential.botToken, ilink_bot_id: credential.botId, ilink_user_id: credential.ownerUserId, baseurl: credential.baseUrl });
  } });
  assert.equal(await runCli(['login', '--state-dir', stateDir], h.io), 0);
  assert.equal(calls, 2);
  assert.equal(result(h).status, 'BOUND');
  assert.equal((await fs.stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(stateDir, 'credentials.json'))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(qrPath), { code: 'ENOENT' });
  assert.equal(h.output.join('').includes(credential.botToken), false);
});

test('login denied consent causes zero provider calls', async t => {
  const { stateDir } = await temp(t);
  const h = harness({ isTerminal: true, ask: async () => 'no' });
  assert.equal(await runCli(['login', '--state-dir', stateDir], h.io), 1);
  assert.equal(error(h).code, 'CONSENT_NOT_GIVEN');
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});

test('missing QR renderer dependency fails before requesting a new QR', async t => {
  const { stateDir } = await temp(t);
  const h = harness({ isTerminal: true, ask: async () => 'BIND MY WECHAT', prepareQr: async () => { throw new Error('fictional module missing'); } });
  assert.equal(await runCli(['login', '--state-dir', stateDir], h.io), 1);
  assert.equal(error(h).code, 'QR_DEPENDENCY_UNAVAILABLE');
});

test('verify deadline aborts a hanging poll, releases lock and sends nothing', async t => {
  const { stateDir } = await bound(t);
  let calls = 0;
  let aborted = false;
  const h = harness({ fetchImpl: async (url, init) => {
    assert.ok(url.endsWith('/getupdates'));
    calls++;
    return await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('fictional aborted poll')); }, { once: true }));
  } });
  const started = performance.now();
  assert.equal(await runCli(['verify', '--state-dir', stateDir, '--expect', 'challenge', '--timeout-seconds', '1'], h.io), 2);
  assert.equal(result(h).status, 'VERIFY_DEADLINE');
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.ok(performance.now() - started < 2500);
  await assert.rejects(fs.stat(path.join(stateDir, 'verify-state.json.lock')), { code: 'ENOENT' });
});

test('verify deadline remains bounded when injected transport ignores abort', async t => {
  const { stateDir } = await bound(t);
  const h = harness({ fetchImpl: async () => new Promise(() => {}) });
  const started = performance.now();
  assert.equal(await runCli(['verify', '--state-dir', stateDir, '--expect', 'challenge', '--timeout-seconds', '1'], h.io), 2);
  assert.equal(result(h).status, 'VERIFY_DEADLINE');
  assert.ok(performance.now() - started < 2500);
  assert.equal(h.io.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(h.io.signalSource.listenerCount('SIGTERM'), 0);
  await assert.rejects(fs.stat(path.join(stateDir, 'verify-state.json.lock')), { code: 'ENOENT' });
});

for (const stage of ['poll', 'send']) test(`child-process ${stage === 'poll' ? 'SIGINT during poll' : 'SIGTERM during send'} releases lock and never reports success`, async t => {
  const { stateDir } = await bound(t);
  const cliUrl = new URL('./cli.mjs', import.meta.url).href;
  const script = `
    import { runCli } from ${JSON.stringify(cliUrl)};
    const args = ['verify', '--state-dir', ${JSON.stringify(stateDir)}, '--expect', 'challenge', '--timeout-seconds', '30', ${stage === 'send' ? "'--reply-text', 'explicit reply'" : ''}];
    process.exitCode = await runCli(args, { fetchImpl: async url => {
      if (${JSON.stringify(stage)} === 'send' && url.endsWith('/getupdates')) return new Response(JSON.stringify({ ret: 0, msgs: [${JSON.stringify(inbound('1'))}] }), { headers: { 'Content-Type': 'application/json' } });
      process.stdout.write('TEST_TRANSPORT_READY\\n');
      return await new Promise(() => {});
    } });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child failed to clean up after signal')); }, 4000);
    child.on('error', failure => { clearTimeout(timeout); reject(failure); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!signalled && stdout.includes('TEST_TRANSPORT_READY')) { signalled = true; child.kill(stage === 'poll' ? 'SIGINT' : 'SIGTERM'); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
  });
  const exit = await completed;
  assert.equal(signalled, true);
  assert.deepEqual(exit, { code: 2, signal: null });
  assert.equal(stderr, '');
  const diagnostic = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(diagnostic.status, stage === 'poll' ? 'VERIFY_INTERRUPTED' : 'OUTCOME_UNKNOWN');
  assert.equal(diagnostic.replyAttempted, stage === 'send');
  assert.equal(stdout.includes('API_ACCEPTED'), false);
  await assert.rejects(fs.stat(path.join(stateDir, 'verify-state.json.lock')), { code: 'ENOENT' });
  if (stage === 'send') {
    const saved = JSON.parse(await fs.readFile(path.join(stateDir, 'verify-state.json'), 'utf8'));
    assert.equal(saved.entries[0].outcome, 'OUTCOME_UNKNOWN');
    const h = harness({ fetchImpl: async url => {
      assert.ok(url.endsWith('/getupdates'));
      return response({ ret: 0, msgs: [inbound('1')] });
    } });
    assert.equal(await runCli(['verify', '--state-dir', stateDir, '--expect', 'challenge', '--reply-text', 'explicit reply', '--max-polls', '1'], h.io), 2);
    assert.equal(result(h).status, 'EXPECT_NOT_SEEN');
  }
});

test('verify exact owner text without reply persists cursor/context and makes no send call', async t => {
  const { stateDir } = await bound(t);
  let polls = 0;
  const h = harness({ fetchImpl: async url => {
    assert.ok(url.endsWith('/getupdates'));
    polls++;
    return response({ ret: 0, get_updates_buf: 'fictional-cursor', msgs: [inbound('1', 'challenge', 'other-user'), inbound('2', 'challenge '), inbound('3')] });
  } });
  assert.equal(await runCli(['verify', '--state-dir', stateDir, '--expect', 'challenge'], h.io), 0);
  assert.equal(polls, 1);
  assert.deepEqual(result(h), { status: 'OWNER_MESSAGE_MATCHED', ownerRestricted: true, replyAttempted: false });
  const saved = JSON.parse(await fs.readFile(path.join(stateDir, 'verify-state.json'), 'utf8'));
  assert.equal(saved.cursor, 'fictional-cursor');
  assert.equal(saved.entries.length, 2);
  assert.equal((await fs.stat(path.join(stateDir, 'verify-state.json'))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(stateDir, 'verify-state.json.lock')), { code: 'ENOENT' });
  const second = harness({ fetchImpl: () => { assert.fail('Durable pending match requires no new poll'); } });
  assert.equal(await runCli(['verify', '--state-dir', stateDir, '--expect', 'challenge'], second.io), 0);
});

for (const outcome of ['API_ACCEPTED', 'OUTCOME_UNKNOWN']) test(`reply ${outcome} is durable and not retried for the same message`, async t => {
  const { stateDir } = await bound(t);
  let sends = 0;
  let polls = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/getupdates')) { polls++; return response({ ret: 0, get_updates_buf: 'fictional-cursor', msgs: [inbound('1')] }); }
    assert.ok(url.endsWith('/sendmessage'));
    sends++;
    const msg = JSON.parse(init.body).msg;
    assert.equal(msg.to_user_id, credential.ownerUserId);
    assert.equal(msg.item_list[0].text_item.text, 'explicit reply');
    if (outcome === 'OUTCOME_UNKNOWN') throw new Error('fictional network loss after send');
    return response({ ret: 0 });
  };
  const h = harness({ fetchImpl });
  const args = ['verify', '--state-dir', stateDir, '--expect', 'challenge', '--reply-text', 'explicit reply', '--max-polls', '1'];
  assert.equal(await runCli(args, h.io), outcome === 'API_ACCEPTED' ? 0 : 2);
  assert.equal(result(h).status, outcome);
  assert.equal(result(h).deliveryConfirmed, false);
  assert.equal(await runCli(args, h.io), 2);
  assert.equal(result(h).status, 'EXPECT_NOT_SEEN');
  assert.equal(sends, 1);
  assert.equal(polls, 2);
  const state = JSON.parse(await fs.readFile(path.join(stateDir, 'verify-state.json'), 'utf8'));
  assert.equal(state.entries[0].outcome, outcome);
  assert.equal(Object.hasOwn(state.entries[0], 'contextToken'), false);
});

test('ambiguous owner messages refuse all sends', async t => {
  const { stateDir } = await bound(t);
  const h = harness({ fetchImpl: async url => {
    assert.ok(url.endsWith('/getupdates'));
    return response({ ret: 0, msgs: [inbound('1'), inbound('2')] });
  } });
  assert.equal(await runCli(['verify', '--state-dir', stateDir, '--expect', 'challenge', '--reply-text', 'explicit'], h.io), 1);
  assert.equal(error(h).code, 'AMBIGUOUS_EXPECT');
});

test('empty updates stop at explicit poll bound and transport failure does not retry', async t => {
  const { stateDir } = await bound(t);
  let calls = 0;
  const h = harness({ fetchImpl: async () => { calls++; return response({ ret: 0, msgs: [] }); } });
  assert.equal(await runCli(['verify', '--state-dir', stateDir, '--expect', 'challenge', '--max-polls', '2'], h.io), 2);
  assert.equal(calls, 2);
  calls = 0;
  const broken = harness({ fetchImpl: async () => { calls++; throw new Error('fictional failure'); } });
  assert.equal(await runCli(['verify', '--state-dir', stateDir, '--expect', 'challenge'], broken.io), 1);
  assert.equal(calls, 1);
  assert.equal(error(broken).code, 'TRANSPORT_ERROR');
});

test('symlink state directory is rejected without following credentials', async t => {
  const { stateDir, parent } = await bound(t);
  const link = path.join(parent, 'link');
  await fs.symlink(stateDir, link);
  const h = harness();
  assert.equal(await runCli(['status', '--state-dir', link], h.io), 1);
  assert.equal(error(h).code, 'STATE_DIRECTORY_INSECURE');
});

test('logout requires consent and refuses unrelated files, then deletes local state without network', async t => {
  const { stateDir } = await bound(t);
  const h = harness({ isTerminal: true, ask: async () => 'DELETE LOCAL DOTS WECHAT' });
  await fs.writeFile(path.join(stateDir, 'keep.txt'), 'unrelated');
  assert.equal(await runCli(['logout', '--state-dir', stateDir], h.io), 1);
  assert.equal(error(h).code, 'UNRECOGNIZED_STATE_FILES');
  await fs.access(path.join(stateDir, 'credentials.json'));
  await fs.unlink(path.join(stateDir, 'keep.txt'));
  assert.equal(await runCli(['logout', '--state-dir', stateDir], h.io), 0);
  assert.deepEqual(result(h), { status: 'LOCAL_CREDENTIALS_DELETED', remoteUnbinding: false });
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});

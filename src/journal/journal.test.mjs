import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDecipheriv } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createJournal, openJournal, JournalError } from './journal.mjs';

const epoch = Date.parse('2026-09-30T12:00:00Z');
const fixtureKey = () => Buffer.alloc(32, 0x53);
const principal = () => ({ tenantId: 'synthetic:tenant:a', subject: 'synthetic:user:a', grantId: 'synthetic:grant:a', bindingId: 'synthetic:binding:a', watchId: 'synthetic:watch:a', generation: 1, revision: 1 });
const message = () => ({ requestId: 'synthetic:request:a', messageId: 'synthetic:message:a', eventId: 'synthetic:event:a', subscriptionId: 'synthetic:subscription:a', text: '[SYNTHETIC] 私有正文仅保存在临时测试目录' });
const code = expected => error => error instanceof JournalError && error.code === expected && error.retryAutomatically === false;
const execute = promisify(execFile);

async function fixture(t, { bind = true } = {}) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'dots-journal-synthetic-'));
  const f = { base, directory: path.join(base, 'store'), key: fixtureKey(), now: epoch, phase: null, principal: principal(), message: message(), handles: [], revision: 0 };
  const options = mode => ({ directory: f.directory, key: f.key, mode, clock: () => f.now, failureInjector: name => { if (f.phase === name) throw new Error('Synthetic persistence failure'); } });
  f.open = async mode => { f.journal = await openJournal(options(mode)); f.handles.push(f.journal); f.revision = (await f.journal.inspect()).commitRevision; return f.journal; };
  f.refresh = async () => { f.revision = (await f.journal.inspect()).commitRevision; };
  f.call = async (method, input = {}) => { const result = await f.journal[method]({ principal: f.principal, ...input, expectedRevision: f.revision }); f.revision = result.commitRevision; return result; };
  f.enqueue = () => f.call('enqueue', f.message);
  f.claim = () => f.call('claimDispatch', { requestId: f.message.requestId });
  f.reply = () => f.call('queueReply', { ...f.message, replyId: 'synthetic:reply:a', text: '[SYNTHETIC] 合成中文回复' });
  f.read = async () => { const value = await f.journal.readStatus({ tenantId: f.principal.tenantId, subject: f.principal.subject, requestId: f.message.requestId }); f.revision = value.commitRevision; return value; };
  f.reopen = async () => { await f.journal.close(); return f.open('open'); };
  f.recoverAfterProvenFixtureShutdown = async () => {
    await f.journal.close();
    await fs.unlink(path.join(f.directory, 'journal.lock'));
    f.phase = null;
    return f.open('recover');
  };
  t.after(async () => { for (const handle of f.handles) await handle.close().catch(() => {}); await fs.rm(base, { recursive: true, force: true }); f.key.fill(0); });
  await f.open('create');
  if (bind) await f.call('bind', { expiresAt: f.now + 3600000 });
  return f;
}

async function decoded(f) {
  const envelope = JSON.parse(await fs.readFile(path.join(f.directory, 'journal.aead'), 'utf8'));
  const decipher = createDecipheriv('aes-256-gcm', f.key, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAAD(Buffer.from(`dots-wechat-journal/1\n${await fs.realpath(f.directory)}`));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}

test('default boundary is inert and requires explicit directory, key and mode', async () => {
  assert.equal(createJournal().status().liveEnabled, false);
  await assert.rejects(createJournal().open(), code('JOURNAL_NOT_CONFIGURED'));
  await assert.rejects(openJournal(), code('EXPLICIT_DIRECTORY_REQUIRED'));
  await assert.rejects(openJournal({ directory: '/synthetic/not-created' }), code('EXPLICIT_256_BIT_KEY_REQUIRED'));
  await assert.rejects(openJournal({ directory: '/synthetic/not-created', key: fixtureKey() }), code('EXPLICIT_OPEN_MODE_REQUIRED'));
});

test('snapshot is authenticated ciphertext, files are private, and shutdown preserves caller key', async t => {
  const f = await fixture(t); await f.enqueue();
  const disk = await fs.readFile(path.join(f.directory, 'journal.aead'), 'utf8');
  for (const secret of [f.message.text, f.principal.subject, f.message.requestId, f.key.toString('hex')]) assert.equal(disk.includes(secret), false);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.directory, 'journal.aead'))).mode & 0o777, 0o600);
  assert.equal(Object.values((await decoded(f)).records)[0].text, f.message.text);
  const before = Buffer.from(f.key); await f.journal.close(); assert.deepEqual(f.key, before);
  await assert.rejects(f.journal.inspect(), code('JOURNAL_CLOSED'));
});

test('normal reopen preserves request IDs, duplicate digests and absolute deadlines', async t => {
  const f = await fixture(t); const first = await f.enqueue();
  await f.reopen(); const duplicate = await f.enqueue();
  assert.equal(duplicate.payloadExpiresAt, first.payloadExpiresAt);
  assert.equal(duplicate.tombstoneUntil, first.tombstoneUntil);
  assert.equal(duplicate.uplink, 'READY');
  await assert.rejects(f.call('enqueue', { ...f.message, text: '[SYNTHETIC] changed' }), code('REQUEST_CONFLICT'));
  await assert.rejects(f.call('enqueue', { ...f.message, requestId: 'synthetic:request:b' }), code('MESSAGE_ALREADY_USED'));
  await assert.rejects(f.call('enqueue', { ...f.message, requestId: 'synthetic:request:b', messageId: 'synthetic:message:b' }), code('EVENT_ALREADY_USED'));
});

test('dispatch is durably UNKNOWN before one payload handoff and is never replayed on reopen', async t => {
  const f = await fixture(t); await f.enqueue(); const claim = await f.claim();
  assert.equal(claim.uplink, 'OUTCOME_UNKNOWN'); assert.equal(claim.text, f.message.text);
  assert.equal(Object.values((await decoded(f)).records)[0].dispatchAttemptId, claim.dispatchAttemptId);
  await f.reopen(); const state = await f.read();
  assert.equal(state.uplink, 'OUTCOME_UNKNOWN'); assert.equal(state.requestId, f.message.requestId); assert.equal(state.retryAutomatically, false);
  assert.equal(Object.hasOwn(state, 'text'), false);
  await assert.rejects(f.claim(), code('DISPATCH_NOT_AVAILABLE'));
});

test('only one concurrent CAS dispatch claim returns a payload', async t => {
  const f = await fixture(t); await f.enqueue();
  const args = { principal: f.principal, requestId: f.message.requestId, expectedRevision: f.revision };
  const results = await Promise.allSettled([f.journal.claimDispatch(args), f.journal.claimDispatch(args)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'COMMIT_REVISION_CONFLICT');
  await f.refresh(); await assert.rejects(f.claim(), code('DISPATCH_NOT_AVAILABLE'));
});

test('late reply resolves UNKNOWN without another dispatch; downlink handoff is also single-attempt', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim();
  const reply = await f.reply(); assert.equal(reply.downlink, 'QUEUED');
  const sent = await f.call('claimReply', { requestId: f.message.requestId });
  assert.equal(sent.downlink, 'OUTCOME_UNKNOWN'); assert.equal(sent.text, '[SYNTHETIC] 合成中文回复');
  await f.reopen();
  await assert.rejects(f.call('claimReply', { requestId: f.message.requestId }), code('REPLY_NOT_AVAILABLE'));
  const state = await f.read(); assert.equal(state.deliveryAttemptId, sent.deliveryAttemptId);
});

test('precise receipt removes both plaintext payloads and duplicates do not extend retention', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim(); await f.reply();
  const sent = await f.call('claimReply', { requestId: f.message.requestId });
  const receipt = { requestId: f.message.requestId, replyId: sent.replyId, attemptId: sent.deliveryAttemptId };
  await assert.rejects(f.call('recordReceipt', { ...receipt, attemptId: 'synthetic:wrong' }), code('CORRELATION_MISMATCH'));
  const applied = await f.call('recordReceipt', receipt);
  assert.equal(applied.downlink, 'RECEIPT_RECORDED'); assert.equal(applied.payloadPresent, false);
  const row = Object.values((await decoded(f)).records)[0]; assert.equal(row.text, null); assert.equal(row.reply.text, null);
  f.now += 1000; const duplicate = await f.call('recordReceipt', receipt);
  assert.equal(duplicate.tombstoneUntil, applied.tombstoneUntil);
  assert.equal(duplicate.personalDot, 'not_connected');
});

test('late uplink rejection never erases recorded receipt or unknown downlink effect', async t => {
  for (const received of [false, true]) {
    const f = await fixture(t); await f.enqueue(); const dispatch = await f.claim(); await f.reply();
    const delivery = await f.call('claimReply', { requestId: f.message.requestId });
    if (received) await f.call('recordReceipt', { requestId: f.message.requestId, replyId: delivery.replyId, attemptId: delivery.deliveryAttemptId });
    const result = await f.call('recordDispatch', { requestId: f.message.requestId, attemptId: dispatch.dispatchAttemptId, outcome: 'REJECTED' });
    assert.equal(result.downlink, received ? 'RECEIPT_RECORDED' : 'OUTCOME_UNKNOWN');
  }
});

test('reply correlation and UTF-8 limits fail before queue mutation', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim();
  const reply = { ...f.message, replyId: 'synthetic:reply:a', text: '[SYNTHETIC] ' + '中'.repeat(678) + 'ab' };
  assert.equal(Buffer.byteLength(reply.text), 2048);
  await assert.rejects(f.call('queueReply', { ...reply, eventId: 'synthetic:wrong' }), code('CORRELATION_MISMATCH'));
  await assert.rejects(f.call('queueReply', { ...reply, text: reply.text + 'c' }), code('INVALID_REPLY'));
  await assert.rejects(f.call('queueReply', { ...reply, text: '[SYNTHETIC] \ud800' }), code('INVALID_REPLY'));
  assert.equal((await f.read()).downlink, 'AWAITING_REPLY');
  await f.call('queueReply', reply);
  await f.reopen(); assert.equal((await f.call('claimReply', { requestId: f.message.requestId })).text, reply.text);
});

test('reply IDs are durable tombstones and cannot be reassigned to another request', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim(); await f.reply();
  const second = { ...f.message, requestId: 'synthetic:request:b', messageId: 'synthetic:message:b', eventId: 'synthetic:event:b' };
  await f.call('enqueue', second); await f.call('claimDispatch', { requestId: second.requestId });
  await f.reopen();
  await assert.rejects(f.call('queueReply', { ...second, replyId: 'synthetic:reply:a', text: '[SYNTHETIC] different reply' }), code('REPLY_ALREADY_USED'));
});

test('ten-minute payload expiry is absolute across duplicate calls and restart', async t => {
  const f = await fixture(t); const created = await f.enqueue(); await f.claim(); await f.reply();
  f.now += 599999; const before = await f.read(); assert.equal(before.payloadPresent, true);
  assert.equal((await f.enqueue()).payloadExpiresAt, created.payloadExpiresAt);
  f.now += 1;
  assert.notEqual(Object.values((await decoded(f)).records)[0].text, null);
  await f.reopen();
  const expired = await f.read(); assert.equal(expired.payloadPresent, false); assert.equal(expired.downlink, 'CANCELLED');
  await assert.rejects(f.call('claimReply', { requestId: f.message.requestId }), code('REPLY_NOT_AVAILABLE'));
  await assert.rejects(f.reply(), code('REPLY_NOT_AVAILABLE'));
  const row = Object.values((await decoded(f)).records)[0]; assert.equal(row.text, null); assert.equal(row.reply.text, null);
});

test('unknown state remains queryable after payload expiry without automatic retry', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim();
  f.now += 600000; await f.journal.sweep(); await f.refresh();
  assert.equal((await f.read()).uplink, 'OUTCOME_UNKNOWN');
  await assert.rejects(f.claim(), code('DISPATCH_NOT_AVAILABLE'));
});

test('revocation atomically cancels queued data and preserves unknown effect history', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim(); await f.reply();
  const result = await f.call('revoke'); assert.equal(result.remoteRevocation, 'not_attempted');
  const state = await f.read(); assert.equal(state.cancelled, true); assert.equal(state.payloadPresent, false); assert.equal(state.uplink, 'OUTCOME_UNKNOWN'); assert.equal(state.downlink, 'CANCELLED');
  await f.reopen(); await assert.rejects(f.reply(), code('STALE_OR_REVOKED_AUTHORIZATION'));
  assert.equal((await f.journal.inspectBinding({ watchId: f.principal.watchId })).generationFloor, 2);
});

test('new binding ID or owner cannot reset the stable watch generation and revision floors', async t => {
  const f = await fixture(t); await f.call('revoke'); await f.reopen();
  const changed = { ...f.principal, tenantId: 'synthetic:tenant:b', subject: 'synthetic:user:b', bindingId: 'synthetic:binding:b', grantId: 'synthetic:grant:b' };
  await assert.rejects(f.call('bind', { principal: changed, expiresAt: f.now + 3600000 }), code('STALE_BINDING_REVISION'));
  await assert.rejects(f.call('bind', { principal: { ...changed, generation: 2 }, expiresAt: f.now + 3600000 }), code('STALE_BINDING_REVISION'));
  await f.call('bind', { principal: { ...changed, generation: 2, revision: 2 }, expiresAt: f.now + 3600000 });
  await assert.rejects(f.enqueue(), code('STALE_OR_REVOKED_AUTHORIZATION'));
});

test('expired dedupe metadata does not expire permanent watch floors or used-grant digests', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim(); await f.call('revoke');
  f.now += 86400001; await f.reopen(); const stats = await f.journal.inspect(); f.revision = stats.commitRevision;
  assert.equal(stats.records, 0); assert.equal(stats.permanentWatchFloors, 1); assert.equal(stats.permanentGrantDigests, 1);
  await assert.rejects(f.read(), code('REQUEST_NOT_FOUND'));
  await assert.rejects(f.call('bind', { principal: { ...f.principal, generation: 2, revision: 2 }, expiresAt: f.now + 3600000 }), code('GRANT_ALREADY_USED'));
  await assert.rejects(f.enqueue(), code('STALE_OR_REVOKED_AUTHORIZATION'));
});

test('long offline expiry does not restart a twenty-four-hour retention timer', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim();
  f.now += 2 * 86400000; await f.reopen();
  assert.equal((await f.journal.inspect()).records, 0);
  await assert.rejects(f.enqueue(), code('STALE_OR_REVOKED_AUTHORIZATION'));
});

test('cancel clears payload but never claims that an unknown external effect was undone', async t => {
  const f = await fixture(t); await f.enqueue(); await f.claim(); await f.reply();
  await f.call('claimReply', { requestId: f.message.requestId });
  const stopped = await f.call('cancel', { requestId: f.message.requestId });
  assert.equal(stopped.uplink, 'OUTCOME_UNKNOWN'); assert.equal(stopped.downlink, 'OUTCOME_UNKNOWN'); assert.equal(stopped.cancelled, true); assert.equal(stopped.payloadPresent, false);
  await f.reopen(); await assert.rejects(f.claim(), code('DISPATCH_NOT_AVAILABLE'));
});

test('stale authorization revision and late result after rebinding cannot commit', async t => {
  const f = await fixture(t); await f.enqueue(); const attempted = await f.claim();
  await assert.rejects(f.call('claimDispatch', { principal: { ...f.principal, revision: 2 }, requestId: f.message.requestId }), code('STALE_OR_REVOKED_AUTHORIZATION'));
  await f.call('bind', { principal: { ...f.principal, grantId: 'synthetic:grant:b', generation: 2, revision: 2 }, expiresAt: f.now + 3600000 });
  await assert.rejects(f.call('recordDispatch', { requestId: f.message.requestId, attemptId: attempted.dispatchAttemptId, outcome: 'ACCEPTED' }), code('STALE_OR_REVOKED_AUTHORIZATION'));
  assert.equal((await f.read()).uplink, 'OUTCOME_UNKNOWN');
});

test('returned snapshots and queued caller arguments cannot mutate committed state', async t => {
  const f = await fixture(t); const args = { principal: { ...f.principal }, ...f.message, expectedRevision: f.revision };
  const pending = f.journal.enqueue(args); args.text = '[SYNTHETIC] mutated'; args.principal.generation = 44;
  const value = await pending; f.revision = value.commitRevision; value.uplink = 'ACCEPTED';
  const sent = await f.claim(); assert.equal(sent.text, f.message.text); assert.equal(sent.generation, 1);
});

test('clock high-water is durable across normal restart and rollback refuses open', async t => {
  const f = await fixture(t); f.now += 5000; await f.journal.inspect(); await f.journal.close(); f.now -= 1;
  await assert.rejects(f.open('open'), code('CLOCK_MOVED_BACKWARDS'));
  f.now += 1; await f.open('open'); assert.equal(f.journal.status().poisoned, false);
});

test('clock rollback poisons an open instance and preserves its recovery fence', async t => {
  const f = await fixture(t); f.now -= 1;
  await assert.rejects(f.journal.inspect(), code('CLOCK_MOVED_BACKWARDS')); assert.equal(f.journal.status().poisoned, true);
  await f.journal.close(); f.now += 1;
  await assert.rejects(f.open('open'), code('JOURNAL_LOCKED_OR_UNAVAILABLE'));
});

test('another writer cannot take an existing lock and recovery never steals it', async t => {
  const f = await fixture(t);
  for (const mode of ['open', 'recover']) await assert.rejects(openJournal({ directory: f.directory, key: f.key, mode, clock: () => f.now }), code('JOURNAL_LOCKED_OR_UNAVAILABLE'));
  assert.equal((await f.journal.inspect()).permanentWatchFloors, 1);
});

test('missing snapshot and wrong create mode never initialize an existing store as empty', async t => {
  const f = await fixture(t); await f.journal.close(); await fs.unlink(path.join(f.directory, 'journal.aead'));
  await assert.rejects(f.open('open'), code('SNAPSHOT_UNAVAILABLE_OR_INVALID'));
  await assert.rejects(f.open('create'), code('JOURNAL_OPEN_FAILED'));
});

test('wrong key, truncated snapshot and authenticated-ciphertext tampering fail closed', async t => {
  for (const damage of ['key', 'truncate', 'ciphertext', 'version']) {
    const f = await fixture(t); await f.enqueue(); await f.journal.close();
    const filename = path.join(f.directory, 'journal.aead');
    if (damage === 'truncate') await fs.writeFile(filename, '{');
    if (['ciphertext', 'version'].includes(damage)) {
      const data = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (damage === 'version') data.format = 'dots-wechat-journal/999';
      else { const bytes = Buffer.from(data.ciphertext, 'base64'); bytes[0] ^= 1; data.ciphertext = bytes.toString('base64'); }
      await fs.writeFile(filename, JSON.stringify(data));
    }
    await assert.rejects(openJournal({ directory: f.directory, key: damage === 'key' ? Buffer.alloc(32, 0x54) : f.key, mode: 'open', clock: () => f.now }), code('SNAPSHOT_UNAVAILABLE_OR_INVALID'));
  }
});

test('directory-bound AAD rejects a valid snapshot copied to another private directory', async t => {
  const f = await fixture(t); await f.journal.close(); const copy = path.join(f.base, 'copy'); await fs.mkdir(copy, { mode: 0o700 });
  await fs.copyFile(path.join(f.directory, 'journal.aead'), path.join(copy, 'journal.aead')); await fs.chmod(path.join(copy, 'journal.aead'), 0o600);
  await assert.rejects(openJournal({ directory: copy, key: f.key, mode: 'open', clock: () => f.now }), code('SNAPSHOT_UNAVAILABLE_OR_INVALID'));
});

test('unsafe directory permissions and symlink snapshots are rejected without reading targets', async t => {
  const f = await fixture(t); await f.journal.close(); await fs.chmod(f.directory, 0o755);
  await assert.rejects(f.open('open'), code('PRIVATE_DIRECTORY_REQUIRED')); await fs.chmod(f.directory, 0o700);
  const target = path.join(f.base, 'synthetic-sentinel'); await fs.writeFile(target, 'synthetic untouched', { mode: 0o600 });
  await fs.unlink(path.join(f.directory, 'journal.aead')); await fs.symlink(target, path.join(f.directory, 'journal.aead'));
  await assert.rejects(f.open('open'), code('SNAPSHOT_UNAVAILABLE_OR_INVALID')); assert.equal(await fs.readFile(target, 'utf8'), 'synthetic untouched');
});

for (const phase of ['after_temp_open', 'after_temp_write', 'after_file_sync', 'before_rename', 'after_rename', 'after_directory_sync']) test(`persistence fault ${phase} poisons the instance and keeps a durable recovery fence`, async t => {
  const f = await fixture(t); await f.enqueue(); f.phase = phase;
  await assert.rejects(f.claim(), error => code('WRITE_OUTCOME_UNKNOWN')(error) && error.outcome === 'OUTCOME_UNKNOWN');
  await assert.rejects(f.journal.inspect(), code('JOURNAL_POISONED'));
  await f.journal.close(); f.phase = null; await assert.rejects(f.open('open'), code('JOURNAL_LOCKED_OR_UNAVAILABLE'));
  await f.recoverAfterProvenFixtureShutdown();
  const status = await f.read();
  assert.equal(status.uplink, ['after_rename', 'after_directory_sync'].includes(phase) ? 'OUTCOME_UNKNOWN' : 'CANCELLED');
  assert.equal(status.cancelled, true); assert.equal(status.payloadPresent, false);
  await assert.rejects(f.claim(), code('STALE_OR_REVOKED_AUTHORIZATION'));
});

test('failed revocation before rename cannot silently restore the old active grant on restart', async t => {
  const f = await fixture(t); await f.enqueue(); f.phase = 'before_rename';
  await assert.rejects(f.call('revoke'), code('WRITE_OUTCOME_UNKNOWN'));
  await f.journal.close(); f.phase = null; await assert.rejects(f.open('open'), code('JOURNAL_LOCKED_OR_UNAVAILABLE'));
  await f.recoverAfterProvenFixtureShutdown();
  await assert.rejects(f.enqueue(), code('STALE_OR_REVOKED_AUTHORIZATION'));
  assert.equal((await f.read()).cancelled, true);
});

test('failed recovery before decryption cannot remove the fence protecting a failed revocation', async t => {
  const f = await fixture(t); await f.enqueue(); f.phase = 'before_rename';
  await assert.rejects(f.call('revoke'), code('WRITE_OUTCOME_UNKNOWN'));
  await f.journal.close(); await fs.unlink(path.join(f.directory, 'journal.lock')); f.phase = null;
  await assert.rejects(openJournal({ directory: f.directory, key: Buffer.alloc(32, 0x54), mode: 'recover', clock: () => f.now }), code('SNAPSHOT_UNAVAILABLE_OR_INVALID'));
  await assert.rejects(f.open('open'), code('JOURNAL_LOCKED_OR_UNAVAILABLE'));
  await f.recoverAfterProvenFixtureShutdown();
  await assert.rejects(f.enqueue(), code('STALE_OR_REVOKED_AUTHORIZATION'));
});

test('failed creation after rename leaves a fenced authenticated store instead of a usable empty fallback', async t => {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'dots-journal-synthetic-create-'));
  const directory = path.join(base, 'store');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await assert.rejects(openJournal({ directory, key: fixtureKey(), mode: 'create', clock: () => epoch, failureInjector: phase => { if (phase === 'after_rename') throw new Error('Synthetic initialization failure'); } }), code('WRITE_OUTCOME_UNKNOWN'));
  await assert.rejects(openJournal({ directory, key: fixtureKey(), mode: 'open', clock: () => epoch }), code('JOURNAL_LOCKED_OR_UNAVAILABLE'));
  await fs.unlink(path.join(directory, 'journal.lock'));
  const recovered = await openJournal({ directory, key: fixtureKey(), mode: 'recover', clock: () => epoch });
  assert.equal((await recovered.inspect()).records, 0); await recovered.close();
});

test('completion persistence failure retains the original unknown attempt instead of offering replay', async t => {
  const f = await fixture(t); await f.enqueue(); const claim = await f.claim(); f.phase = 'before_rename';
  await assert.rejects(f.call('recordDispatch', { requestId: f.message.requestId, attemptId: claim.dispatchAttemptId, outcome: 'ACCEPTED' }), code('WRITE_OUTCOME_UNKNOWN'));
  await f.recoverAfterProvenFixtureShutdown(); const status = await f.read();
  assert.equal(status.dispatchAttemptId, claim.dispatchAttemptId); assert.equal(status.uplink, 'OUTCOME_UNKNOWN');
});

for (const phase of ['after_temp_write', 'after_rename']) test(`actual child-process exit at ${phase} leaves a lock and recovers only under explicit invalidation`, async t => {
  const f = await fixture(t); await f.enqueue(); await f.journal.close();
  const moduleUrl = new URL('./journal.mjs', import.meta.url).href;
  const script = `import {openJournal} from ${JSON.stringify(moduleUrl)}; const j=await openJournal({directory:process.argv[1],key:Buffer.alloc(32,0x53),mode:'open',clock:()=>${epoch},failureInjector:stage=>{if(stage===${JSON.stringify(phase)})process.exit(73)}}); await j.claimDispatch({principal:${JSON.stringify(f.principal)},requestId:${JSON.stringify(f.message.requestId)},expectedRevision:${f.revision}});`;
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', script, f.directory]), error => error.code === 73);
  await assert.rejects(f.open('open'), code('JOURNAL_LOCKED_OR_UNAVAILABLE'));
  await f.recoverAfterProvenFixtureShutdown();
  const status = await f.read(); assert.equal(status.uplink, phase === 'after_rename' ? 'OUTCOME_UNKNOWN' : 'CANCELLED');
  assert.equal(status.cancelled, true); assert.deepEqual((await fs.readdir(f.directory)).sort(), ['journal.aead', 'journal.lock']);
});

test('close drains prior work, rejects new work, and releases a healthy writer lock', async t => {
  const f = await fixture(t); const pending = f.enqueue(); const closing = f.journal.close();
  await assert.rejects(f.journal.inspect(), code('JOURNAL_CLOSED')); await pending; await closing;
  await f.open('open'); assert.equal((await f.read()).uplink, 'READY');
});

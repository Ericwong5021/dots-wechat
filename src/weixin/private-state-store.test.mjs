import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createPrivateStateStore, MAX_STATE_BYTES } from './private-state-store.mjs';

const execute = promisify(execFile);
const moduleUrl = new URL('./private-state-store.mjs', import.meta.url).href;
const ioError = () => Object.assign(new Error('synthetic failure'), { code: 'EIO' });

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'private-state-test-')));
  await fs.chmod(temporary, 0o700);
  const directory = path.join(temporary, 'state');
  await fs.mkdir(directory, { mode: 0o700 });
  const statePath = path.join(directory, 'state.json');
  const stores = [];
  t.after(async () => {
    try { for (const store of stores) await store.close(); }
    finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
  return { temporary, directory, statePath, stores };
}
async function opening(t, f) {
  const store = await createPrivateStateStore(f);
  f.stores.push(store);
  return store;
}
const code = (expected) => (e) => e.code === expected;

test('absent state, exact permissions, round trip, reopen, and idempotent close', async t => {
  const f = await fixture(t);
  const store = await createPrivateStateStore(f);
  assert.equal(await store.load(), null);
  assert.equal((await fs.stat(`${f.statePath}.lock`)).mode & 0o7777, 0o600);
  await store.save({ cursor: 'synthetic-only', pending: [{ context: 'fixture' }] });
  assert.equal((await fs.stat(f.statePath)).mode & 0o7777, 0o600);
  assert.deepEqual(await store.load(), { cursor: 'synthetic-only', pending: [{ context: 'fixture' }] });
  await Promise.all([store.close(), store.close()]);
  await assert.rejects(store.load(), code('STATE_STORE_CLOSED'));
  await assert.rejects(store.save({}), code('STATE_STORE_CLOSED'));
  await assert.rejects(fs.stat(`${f.statePath}.lock`), { code: 'ENOENT' });
  const reopened = await opening(t, f);
  assert.equal((await reopened.load()).cursor, 'synthetic-only');
});

test('insecure parent is rejected without a lock or state write', async t => {
  const f = await fixture(t);
  await fs.chmod(f.directory, 0o750);
  await assert.rejects(createPrivateStateStore(f), code('STATE_PARENT_INSECURE'));
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('symlink parent and symlink ancestor are rejected as noncanonical', async t => {
  const f = await fixture(t);
  const alias = path.join(f.temporary, 'alias');
  await fs.symlink(f.directory, alias);
  await assert.rejects(createPrivateStateStore({ statePath: path.join(alias, 'state.json') }), code('STATE_PARENT_INSECURE'));
  const nested = path.join(f.directory, 'nested');
  await fs.mkdir(nested, { mode: 0o700 });
  await assert.rejects(createPrivateStateStore({ statePath: path.join(alias, 'nested', 'state.json') }), code('STATE_PARENT_INSECURE'));
});

test('relative or nonnormalized state paths are rejected', async () => {
  for (const statePath of ['local.json', '/tmp/a/../b.json', '/tmp/b/./state.json', '/']) {
    await assert.rejects(createPrivateStateStore({ statePath }), code('STATE_PATH_INVALID'));
  }
});

test('exclusive lock blocks another store and a separate process', async t => {
  const f = await fixture(t);
  await opening(t, f);
  await assert.rejects(createPrivateStateStore(f), code('STATE_LOCKED'));
  const script = `import {createPrivateStateStore} from ${JSON.stringify(moduleUrl)};try {const s=await createPrivateStateStore({statePath:process.argv[1]});await s.close();process.exitCode=7;}catch(e){if(e.code!=='STATE_LOCKED')process.exitCode=8;}`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', script, f.statePath]);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('existing stale lock is never guessed safe or deleted', async t => {
  const f = await fixture(t);
  await fs.writeFile(`${f.statePath}.lock`, 'synthetic-stale-lock', { mode: 0o600 });
  await assert.rejects(createPrivateStateStore(f), code('STATE_LOCKED'));
  assert.equal(await fs.readFile(`${f.statePath}.lock`, 'utf8'), 'synthetic-stale-lock');
});

test('symlink lock is not followed or removed', async t => {
  const f = await fixture(t);
  const outside = path.join(f.temporary, 'outside');
  await fs.writeFile(outside, 'unchanged', { mode: 0o600 });
  await fs.symlink(outside, `${f.statePath}.lock`);
  await assert.rejects(createPrivateStateStore(f), code('STATE_LOCKED'));
  assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged');
  assert.equal((await fs.lstat(`${f.statePath}.lock`)).isSymbolicLink(), true);
});

test('symlink, hardlink, directory, and permissive state are rejected for read AND write', async t => {
  const f = await fixture(t);
  const store = await opening(t, f);
  const outside = path.join(f.temporary, 'outside');
  await fs.writeFile(outside, '{"preserved":true}', { mode: 0o600 });
  for (const setup of [
    () => fs.symlink(outside, f.statePath),
    () => fs.link(outside, f.statePath),
    () => fs.mkdir(f.statePath, { mode: 0o700 }),
    async () => { await fs.writeFile(f.statePath, '{}', { mode: 0o600 }); await fs.chmod(f.statePath, 0o644); },
  ]) {
    await setup();
    await assert.rejects(store.load(), code('STATE_FILE_INSECURE'));
    await assert.rejects(store.save({ replaced: true }), code('STATE_FILE_INSECURE'));
    await fs.rm(f.statePath, { recursive: true });
  }
  assert.equal(await fs.readFile(outside, 'utf8'), '{"preserved":true}');
});

test('invalid JSON and invalid UTF-8 reject with no content or path in errors', async t => {
  const f = await fixture(t);
  const store = await opening(t, f);
  for (const data of ['sensitive-fixture-garbage', Buffer.from([0x22, 0xff, 0x22])]) {
    await fs.writeFile(f.statePath, data, { mode: 0o600 });
    await assert.rejects(store.load(), e => {
      assert.equal(e.code, 'STATE_INVALID_JSON');
      assert.equal(String(e).includes(f.statePath), false);
      assert.equal(String(e).includes('sensitive-fixture'), false);
      return true;
    });
  }
});

test('byte limit applies to input serialization and existing on-disk files', async t => {
  const f = await fixture(t);
  const store = await opening(t, f);
  await store.save({ old: true });
  await assert.rejects(store.save({ data: '界'.repeat(MAX_STATE_BYTES / 2) }), code('STATE_TOO_LARGE'));
  assert.deepEqual(await store.load(), { old: true });
  await fs.writeFile(f.statePath, Buffer.alloc(MAX_STATE_BYTES + 1));
  await assert.rejects(store.load(), code('STATE_TOO_LARGE'));
  await assert.rejects(store.save({}), code('STATE_TOO_LARGE'));
});

test('serialization error leaves old state intact', async t => {
  const f = await fixture(t);
  const store = await opening(t, f);
  await store.save({ old: true });
  const circular = {}; circular.self = circular;
  for (const snapshot of [circular, undefined, { n: 1n }]) {
    await assert.rejects(store.save(snapshot), code('STATE_NOT_JSON'));
  }
  assert.deepEqual(await store.load(), { old: true });
});

test('concurrent calls serialize, capture snapshots at call time, and close drains queue', async t => {
  const f = await fixture(t);
  const store = await createPrivateStateStore(f);
  const snapshot = { n: 1 };
  const first = store.save(snapshot);
  snapshot.n = 999;
  const observed = store.load();
  const last = store.save({ n: 2 });
  const closing = store.close();
  await Promise.all([first, last, closing]);
  assert.deepEqual(await observed, { n: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(f.statePath, 'utf8')), { n: 2 });
});

test('atomic replacements expose complete old or new JSON to concurrent readers', async t => {
  const f = await fixture(t);
  const store = await opening(t, f);
  const value = n => ({ n, payload: String(n).repeat(3000) });
  await store.save(value(0));
  let writing = true;
  let reads = 0;
  const reader = (async () => {
    while (writing) {
      const current = JSON.parse(await fs.readFile(f.statePath, 'utf8'));
      assert.deepEqual(current, value(current.n));
      reads++;
    }
  })();
  try { for (let n = 1; n <= 25; n++) await store.save(value(n)); }
  finally { writing = false; await reader; }
  assert.ok(reads > 0);
});

test('rename I/O failure preserves previous inode/data and cleans temporary file', async t => {
  const f = await fixture(t);
  const store = await opening(t, f);
  await store.save({ old: true });
  const before = await fs.stat(f.statePath);
  const originalRename = fs.rename;
  fs.rename = async () => { throw ioError(); };
  try { await assert.rejects(store.save({ new: true }), e => e.code === 'STATE_WRITE_FAILED' && e.systemCode === 'EIO'); }
  finally { fs.rename = originalRename; }
  assert.equal((await fs.stat(f.statePath)).ino, before.ino);
  assert.deepEqual(await store.load(), { old: true });
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['state.json', 'state.json.lock']);
});

for (const failedMethod of ['writeFile', 'sync']) {
  test(`temporary ${failedMethod} I/O failure preserves old state`, async t => {
    const f = await fixture(t);
    const store = await opening(t, f);
    await store.save({ old: true });
    const originalOpen = fs.open;
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes('.tmp-')) handle[failedMethod] = async () => { throw ioError(); };
      return handle;
    };
    try { await assert.rejects(store.save({ new: true }), e => e.code === 'STATE_WRITE_FAILED' && e.systemCode === 'EIO'); }
    finally { fs.open = originalOpen; }
    assert.deepEqual(await store.load(), { old: true });
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['state.json', 'state.json.lock']);
  });
}

test('directory fsync failure after rename is explicit COMMIT_UNCERTAIN, never false rollback', async t => {
  const f = await fixture(t);
  const store = await opening(t, f);
  await store.save({ old: true });
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.directory) handle.sync = async () => { throw ioError(); };
    return handle;
  };
  try { await assert.rejects(store.save({ new: true }), e => e.code === 'STATE_COMMIT_UNCERTAIN' && e.systemCode === 'EIO'); }
  finally { fs.open = originalOpen; }
  assert.deepEqual(await store.load(), { new: true });
});

test('replacement lock is never deleted by the old owner', async t => {
  const f = await fixture(t);
  const store = await createPrivateStateStore(f);
  await fs.rename(`${f.statePath}.lock`, path.join(f.directory, 'moved-lock'));
  await fs.writeFile(`${f.statePath}.lock`, 'replacement', { mode: 0o600 });
  await assert.rejects(store.load(), code('STATE_LOCK_CHANGED'));
  await assert.rejects(store.close(), code('STATE_LOCK_CHANGED'));
  assert.equal(await fs.readFile(`${f.statePath}.lock`, 'utf8'), 'replacement');
});

test('parent inode replacement is rejected before access', async t => {
  const f = await fixture(t);
  const store = await createPrivateStateStore(f);
  await fs.rename(f.directory, path.join(f.temporary, 'moved-state'));
  await fs.mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(store.save({}), code('STATE_PARENT_CHANGED'));
  await assert.rejects(store.close(), code('STATE_PARENT_CHANGED'));
  assert.deepEqual(await fs.readdir(f.directory), []);
});

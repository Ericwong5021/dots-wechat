import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createWeixinTextClient } from './client.mjs';

const BOT = 'synthetic-bot';
const OWNER = 'synthetic-owner';
const TOKEN = 'synthetic-auth-never-persist';
const CONTEXT = 'synthetic-private-context';
const ID = '18446744073709551615';
const CLIENT = 'dots-89a744bc-72f8-47a7-b21b-0445c42317f5';
const START = 1790800000000;
const TEXT = 'synthetic inbound only';

function incoming(overrides = {}) {
  return { message_id: ID, from_user_id: OWNER, to_user_id: BOT, message_type: 1, message_state: 2, context_token: CONTEXT, item_list: [{ type: 1, text_item: { text: TEXT } }], ...overrides };
}

function json(body) { return new Response(JSON.stringify(body)); }
function updates(messages = [incoming()], cursor = 'synthetic-cursor') { return json({ msgs: messages, get_updates_buf: cursor }); }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function record(overrides = {}) { return { id: ID, clientId: CLIENT, createdAtMs: START, outcome: null, text: TEXT, contextToken: CONTEXT, ...overrides }; }
function snapshot(entries = [record()], overrides = {}) { return { schemaVersion: 1, botId: BOT, ownerUserId: OWNER, cursor: 'restored-cursor', lastObservedAtMs: START, entries, ...overrides }; }

function memoryStore(initial) {
  let saved = clone(initial);
  const writes = [];
  const state = { failSave: false, failLoad: false, failAfterWrite: false, closed: 0, saves: 0, loadCalls: 0, saveHook: null };
  const store = {
    async load() { state.loadCalls++; if (state.failLoad) throw new Error('synthetic-private-failure'); return clone(saved); },
    async save(next) {
      state.saves++;
      if (state.saveHook) await state.saveHook(next);
      if (state.failSave) throw new Error('synthetic-private-failure');
      saved = clone(next);
      writes.push(clone(next));
      if (state.failAfterWrite) throw new Error('synthetic-private-failure');
    },
    async close() { state.closed++; }
  };
  return { store, state, writes, saved: () => clone(saved) };
}

function setup(replies = [], options = {}) {
  const calls = [];
  const queue = [...replies];
  const clock = { value: START };
  const client = createWeixinTextClient({
    enabled: true, botToken: TOKEN, botId: BOT, ownerUserId: OWNER, wallNow: () => clock.value,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const reply = queue.shift();
      if (typeof reply === 'function') return reply(url, init);
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error('UNEXPECTED_NETWORK');
      return reply;
    }, ...options
  });
  return { client, calls, queue, clock };
}

test('durable store interface configuration is validated without touching storage', () => {
  for (const stateStore of [null, {}, { load() {}, save() {} }, { load: 1, save() {}, close() {} }]) assert.throws(() => setup([], { stateStore }), /INVALID_CONFIGURATION/);
});

test('disabled and closed clients never load storage or network', async () => {
  const memory = memoryStore();
  const disabled = setup([], { stateStore: memory.store, enabled: false });
  assert.equal((await disabled.client.initialize()).status, 'DISABLED');
  assert.equal((await disabled.client.pendingMessages()).status, 'DISABLED');
  assert.equal((await disabled.client.getUpdates()).status, 'DISABLED');
  assert.equal(memory.state.loadCalls, 0);
  const active = setup([], { stateStore: memory.store });
  await active.client.close();
  assert.equal((await active.client.initialize()).status, 'STOPPED');
  assert.equal(memory.state.loadCalls, 0);
});

test('initialization restores exact uint64 ID and private instance capabilities, never auth token', async () => {
  const memory = memoryStore(snapshot());
  const { client, calls } = setup([json({ ret: 0 })], { stateStore: memory.store });
  assert.deepEqual(await client.initialize(), { status: 'OK', restoredCount: 1 });
  const recovered = await client.pendingMessages();
  assert.equal(recovered.messages[0].messageId, ID);
  assert.equal((await client.sendText({ inbound: { ...recovered.messages[0] }, text: 'reply' })).status, 'INVALID_INBOUND');
  for (const secret of [TOKEN, BOT, OWNER, CONTEXT, ID, TEXT]) {
    assert.ok(!JSON.stringify(recovered).includes(secret));
    assert.ok(!inspect(recovered).includes(secret));
  }
  assert.equal((await client.sendText({ inbound: recovered.messages[0], text: 'reply' })).status, 'API_ACCEPTED');
  assert.equal(calls[0].body.msg.client_id, CLIENT);
  assert.equal(calls[0].body.msg.context_token, CONTEXT);
  assert.ok(!JSON.stringify(memory.writes).includes(TOKEN));
  assert.deepEqual(Object.keys(memory.saved().entries[0]).sort(), ['clientId', 'createdAtMs', 'id', 'outcome']);
});

test('atomic incoming snapshot precedes delivery, restarts retain pending and cursor', async () => {
  const memory = memoryStore();
  const first = setup([updates()], { stateStore: memory.store });
  const result = await first.client.getUpdates();
  assert.equal(result.status, 'OK');
  assert.equal(memory.saved().entries[0].id, ID);
  assert.equal(memory.saved().cursor, 'synthetic-cursor');
  await first.client.close();
  const second = setup([updates([], 'next')], { stateStore: memory.store });
  const restored = await second.client.pendingMessages();
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0].text, TEXT);
  assert.equal((await second.client.sendText({ inbound: result.messages[0], text: 'foreign prior instance' })).status, 'INVALID_INBOUND');
  await second.client.getUpdates();
  assert.equal(second.calls[0].body.get_updates_buf, 'synthetic-cursor');
  assert.equal(memory.saved().cursor, 'next');
});

test('cursor and pending are committed together before the poll promise resolves', async () => {
  const memory = memoryStore();
  const harness = setup([updates()], { stateStore: memory.store });
  await harness.client.initialize();
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  memory.state.saveHook = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  let delivered = false;
  const poll = harness.client.getUpdates().then(value => { delivered = true; return value; });
  await enteredPromise;
  assert.equal(delivered, false);
  assert.equal(memory.saved().entries.length, 0);
  release();
  assert.equal((await poll).messages.length, 1);
});

test('getUpdates save failure releases no messages, retains old disk cursor, blocks further HTTP', async () => {
  const memory = memoryStore(snapshot([]));
  const harness = setup([updates()], { stateStore: memory.store });
  await harness.client.initialize();
  memory.state.failSave = true;
  assert.deepEqual(await harness.client.getUpdates(), { status: 'STORAGE_BLOCKED', messages: [], rejectedCount: 0 });
  assert.equal(memory.saved().cursor, 'restored-cursor');
  assert.equal((await harness.client.getUpdates()).status, 'STORAGE_BLOCKED');
  assert.equal((await harness.client.sendText({})).status, 'STORAGE_BLOCKED');
  assert.equal((await harness.client.pendingMessages()).status, 'STORAGE_BLOCKED');
  assert.equal(harness.calls.length, 1);
});

test('crash after atomic poll save but before delivery restores the new pending message', async () => {
  const memory = memoryStore(snapshot([]));
  const harness = setup([updates()], { stateStore: memory.store });
  await harness.client.initialize();
  memory.state.failAfterWrite = true;
  assert.equal((await harness.client.getUpdates()).status, 'STORAGE_BLOCKED');
  assert.equal(memory.saved().cursor, 'synthetic-cursor');
  memory.state.failAfterWrite = false;
  const restarted = setup([], { stateStore: memory.store });
  const pending = await restarted.client.pendingMessages();
  assert.equal(pending.messages.length, 1);
  assert.equal(pending.messages[0].messageId, ID);
});

test('IN_FLIGHT tombstone is durable and removes private context before POST', async () => {
  const memory = memoryStore(snapshot());
  const harness = setup([() => {
    const disk = memory.saved();
    assert.equal(disk.entries[0].outcome, 'IN_FLIGHT');
    assert.equal(disk.entries[0].contextToken, undefined);
    assert.equal(disk.entries[0].text, undefined);
    return json({ ret: 0 });
  }], { stateStore: memory.store });
  const inbound = (await harness.client.pendingMessages()).messages[0];
  assert.equal((await harness.client.sendText({ inbound, text: 'reply' })).status, 'API_ACCEPTED');
  assert.equal(memory.saved().entries[0].outcome, 'API_ACCEPTED');
});

test('pre-send storage failure prevents POST even if atomic rename happened before failure', async () => {
  for (const afterWrite of [false, true]) {
    const memory = memoryStore(snapshot());
    const harness = setup([], { stateStore: memory.store });
    const inbound = (await harness.client.pendingMessages()).messages[0];
    memory.state[afterWrite ? 'failAfterWrite' : 'failSave'] = true;
    assert.deepEqual(await harness.client.sendText({ inbound, text: 'reply' }), { status: 'STORAGE_BLOCKED', attempted: false });
    assert.equal(harness.calls.length, 0);
    assert.equal((await harness.client.getUpdates()).status, 'STORAGE_BLOCKED');
    if (afterWrite) assert.equal(memory.saved().entries[0].outcome, 'IN_FLIGHT');
  }
});

test('final save failure yields OUTCOME_UNKNOWN, disk IN_FLIGHT blocks all replay after restart', async () => {
  const memory = memoryStore(snapshot());
  const harness = setup([() => { memory.state.failSave = true; return json({ ret: 0 }); }], { stateStore: memory.store });
  const inbound = (await harness.client.pendingMessages()).messages[0];
  assert.deepEqual(await harness.client.sendText({ inbound, text: 'reply' }), { status: 'OUTCOME_UNKNOWN', attempted: true, deliveryConfirmed: false, storageStatus: 'STORAGE_BLOCKED' });
  assert.equal(memory.saved().entries[0].outcome, 'IN_FLIGHT');
  assert.equal((await harness.client.sendText({ inbound, text: 'retry' })).status, 'STORAGE_BLOCKED');
  assert.equal(harness.calls.length, 1);
  memory.state.failSave = false;
  const restarted = setup([updates()], { stateStore: memory.store });
  assert.equal((await restarted.client.pendingMessages()).messages.length, 0);
  assert.equal(memory.saved().entries[0].outcome, 'OUTCOME_UNKNOWN');
  assert.equal((await restarted.client.getUpdates()).messages.length, 0);
  assert.equal(restarted.calls.length, 1);
});

test('all terminal outcomes restore as tombstones and never resurface from duplicate server messages', async () => {
  for (const outcome of ['IN_FLIGHT', 'OUTCOME_UNKNOWN', 'API_ACCEPTED', 'REJECTED', 'SESSION_EXPIRED', 'EXPIRED_CONTEXT']) {
    const entry = record({ outcome });
    delete entry.text;
    delete entry.contextToken;
    const memory = memoryStore(snapshot([entry]));
    const harness = setup([updates()], { stateStore: memory.store });
    assert.equal((await harness.client.pendingMessages()).messages.length, 0);
    const result = await harness.client.getUpdates();
    assert.equal(result.messages.length, 0);
    assert.equal(result.rejectedCount, 1);
    assert.equal(memory.saved().entries[0].outcome, outcome === 'IN_FLIGHT' ? 'OUTCOME_UNKNOWN' : outcome);
  }
});

test('pending absolute age survives restart and expires without extending reply lifetime', async () => {
  const memory = memoryStore(snapshot());
  const first = setup([], { stateStore: memory.store });
  first.clock.value = START + 599999;
  assert.equal((await first.client.pendingMessages()).messages.length, 1);
  await first.client.close();
  const second = setup([], { stateStore: memory.store });
  second.clock.value = START + 600000;
  assert.equal((await second.client.pendingMessages()).messages.length, 0);
  assert.equal(memory.saved().entries[0].outcome, 'EXPIRED_CONTEXT');
  assert.equal(memory.saved().entries[0].contextToken, undefined);
  assert.equal(second.calls.length, 0);
});

test('pendingMessages expires previously delivered capabilities and persists a tombstone', async () => {
  const memory = memoryStore(snapshot());
  const harness = setup([], { stateStore: memory.store });
  const inbound = (await harness.client.pendingMessages()).messages[0];
  harness.clock.value += 600000;
  assert.equal((await harness.client.pendingMessages()).messages.length, 0);
  assert.equal((await harness.client.sendText({ inbound, text: 'late' })).outcome, 'EXPIRED_CONTEXT');
  assert.equal(memory.saved().entries[0].outcome, 'EXPIRED_CONTEXT');
});

test('send expires original absolute context before network', async () => {
  const memory = memoryStore(snapshot());
  const harness = setup([], { stateStore: memory.store });
  const inbound = (await harness.client.pendingMessages()).messages[0];
  harness.clock.value += 600000;
  assert.equal((await harness.client.sendText({ inbound, text: 'late' })).status, 'EXPIRED_CONTEXT');
  assert.equal(memory.saved().entries[0].outcome, 'EXPIRED_CONTEXT');
  assert.equal(harness.calls.length, 0);
});

test('clock rollback blocks restored and current sessions without HTTP', async () => {
  const memory = memoryStore(snapshot());
  const restored = setup([], { stateStore: memory.store });
  restored.clock.value = START - 1;
  assert.equal((await restored.client.initialize()).status, 'STORAGE_BLOCKED');
  assert.equal(restored.calls.length, 0);
  const current = setup([], { stateStore: memory.store });
  const inbound = (await current.client.pendingMessages()).messages[0];
  current.clock.value--;
  assert.equal((await current.client.sendText({ inbound, text: 'reply' })).status, 'STORAGE_BLOCKED');
  assert.equal(current.calls.length, 0);
});

const malformedStates = [
  ['owner mismatch', value => { value.ownerUserId = 'other-owner'; }],
  ['bot mismatch', value => { value.botId = 'other-bot'; }],
  ['schema mismatch', value => { value.schemaVersion = 2; }],
  ['auth token field', value => { value.botToken = TOKEN; }],
  ['missing last time', value => { delete value.lastObservedAtMs; }],
  ['future last time', value => { value.lastObservedAtMs++; }],
  ['numeric ID', value => { value.entries[0].id = 42; }],
  ['noncanonical ID', value => { value.entries[0].id = '001'; }],
  ['overflow ID', value => { value.entries[0].id = '18446744073709551616'; }],
  ['duplicate ID', value => { value.entries.push(clone(value.entries[0])); }],
  ['duplicate client ID', value => { value.entries.push({ ...value.entries[0], id: '43' }); }],
  ['missing client ID', value => { delete value.entries[0].clientId; }],
  ['invalid client ID', value => { value.entries[0].clientId = 'client\n'; }],
  ['future creation', value => { value.entries[0].createdAtMs++; }],
  ['creation after save', value => { value.lastObservedAtMs--; }],
  ['negative creation', value => { value.entries[0].createdAtMs = -1; }],
  ['missing context', value => { delete value.entries[0].contextToken; }],
  ['invalid context', value => { value.entries[0].contextToken = ' '; }],
  ['unknown outcome', value => { value.entries[0].outcome = 'SENT'; }],
  ['terminal keeps text/context', value => { value.entries[0].outcome = 'IN_FLIGHT'; }],
  ['oversized text', value => { value.entries[0].text = 'x'.repeat(4001); }],
  ['unsafe text', value => { value.entries[0].text = '\ud800'; }],
  ['oversized cursor', value => { value.cursor = 'x'.repeat(16385); }],
  ['wrong cursor', value => { value.cursor = null; }],
  ['non-array entries', value => { value.entries = {}; }],
  ['over capacity', value => { value.entries = Array.from({ length: 1025 }, () => record()); }]
];
for (const [label, change] of malformedStates) {
  test(`malformed snapshot fails closed: ${label}`, async () => {
    const value = snapshot();
    change(value);
    const memory = memoryStore(value);
    const harness = setup([], { stateStore: memory.store });
    const result = await harness.client.initialize();
    assert.equal(result.status, 'STORAGE_BLOCKED');
    assert.equal((await harness.client.getUpdates()).status, 'STORAGE_BLOCKED');
    assert.equal(harness.calls.length, 0);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
}

test('store read and initial write failures block before any network', async () => {
  for (const field of ['failLoad', 'failSave']) {
    const memory = memoryStore();
    memory.state[field] = true;
    const harness = setup([], { stateStore: memory.store });
    assert.equal((await harness.client.getUpdates()).status, 'STORAGE_BLOCKED');
    assert.equal((await harness.client.sendText({})).status, 'STORAGE_BLOCKED');
    assert.equal(harness.calls.length, 0);
  }
});

test('serialized initialization, poll and send cannot overwrite each other snapshots', async () => {
  const memory = memoryStore(snapshot());
  let releasePoll;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const harness = setup([
    () => { entered(); return new Promise(resolve => { releasePoll = () => resolve(updates([incoming({ message_id: '43' })], 'next')); }); },
    json({ ret: 0 })
  ], { stateStore: memory.store });
  await Promise.all([harness.client.initialize(), harness.client.initialize()]);
  assert.equal(memory.state.loadCalls, 1);
  const inbound = (await harness.client.pendingMessages()).messages[0];
  const poll = harness.client.getUpdates();
  await enteredPromise;
  const send = harness.client.sendText({ inbound, text: 'reply' });
  assert.equal(harness.calls.length, 1);
  releasePoll();
  assert.equal((await poll).messages.length, 1);
  assert.equal((await send).status, 'API_ACCEPTED');
  const disk = memory.saved();
  assert.equal(disk.cursor, 'next');
  assert.equal(disk.entries.length, 2);
  assert.equal(disk.entries.find(entry => entry.id === ID).outcome, 'API_ACCEPTED');
  assert.equal(disk.entries.find(entry => entry.id === '43').outcome, null);
});

test('concurrent durable sends make exactly one POST and persist a single client ID', async () => {
  const memory = memoryStore(snapshot());
  const harness = setup([json({ ret: 0 })], { stateStore: memory.store });
  const inbound = (await harness.client.pendingMessages()).messages[0];
  const result = await Promise.all([harness.client.sendText({ inbound, text: 'first' }), harness.client.sendText({ inbound, text: 'second' })]);
  assert.equal(result[0].status, 'API_ACCEPTED');
  assert.equal(result[1].status, 'ALREADY_ATTEMPTED');
  assert.equal(harness.calls.length, 1);
});

test('close waits for send final persistence and closes store once without corrupting other pending entries', async () => {
  const another = record({ id: '43', clientId: 'dots-89a744bc-72f8-47a7-b21b-0445c42317f6' });
  const memory = memoryStore(snapshot([record(), another]));
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const harness = setup([() => { entered(); return new Promise(resolve => { release = resolve; }); }], { stateStore: memory.store });
  const inbound = (await harness.client.pendingMessages()).messages[0];
  const send = harness.client.sendText({ inbound, text: 'reply' });
  await enteredPromise;
  const closing = harness.client.close();
  assert.equal(memory.state.closed, 0);
  release(json({ ret: 0 }));
  assert.equal((await send).status, 'OUTCOME_UNKNOWN');
  await closing;
  await harness.client.close();
  assert.equal(memory.state.closed, 1);
  assert.equal(memory.saved().cursor, 'restored-cursor');
  const restarted = setup([], { stateStore: memory.store });
  assert.equal((await restarted.client.pendingMessages()).messages.length, 1);
  assert.equal((await harness.client.pendingMessages()).status, 'STOPPED');
});

test('capacity refuses to evict persistent tombstones or progress cursor', async () => {
  const entries = Array.from({ length: 1024 }, (_, index) => ({ id: String(index), clientId: `dots-00000000-0000-0000-0000-${String(index).padStart(12, '0')}`, createdAtMs: START, outcome: 'API_ACCEPTED' }));
  const memory = memoryStore(snapshot(entries));
  const harness = setup([], { stateStore: memory.store });
  assert.equal((await harness.client.getUpdates()).status, 'SESSION_LIMIT');
  assert.equal(harness.calls.length, 0);
  assert.equal(memory.saved().entries.length, 1024);
  assert.equal(memory.saved().cursor, 'restored-cursor');
});

test('context expiring during pre-send commit is not posted to network', async () => {
  const memory = memoryStore(snapshot());
  const harness = setup([], { stateStore: memory.store });
  const inbound = (await harness.client.pendingMessages()).messages[0];
  memory.state.saveHook = async next => {
    if (next.entries[0].outcome === 'IN_FLIGHT') harness.clock.value += 600000;
  };
  assert.equal((await harness.client.sendText({ inbound, text: 'late reply' })).status, 'EXPIRED_CONTEXT');
  assert.equal(harness.calls.length, 0);
  assert.equal(memory.saved().entries[0].outcome, 'EXPIRED_CONTEXT');
});

test('close during pending expiration commit cannot release remaining private inbounds', async () => {
  const later = record({ id: '43', clientId: 'dots-89a744bc-72f8-47a7-b21b-0445c42317f6', createdAtMs: START + 1 });
  const memory = memoryStore(snapshot([record(), later], { lastObservedAtMs: START + 1 }));
  const harness = setup([], { stateStore: memory.store });
  harness.clock.value = START + 1;
  await harness.client.initialize();
  harness.clock.value = START + 600000;
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  memory.state.saveHook = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const pending = harness.client.pendingMessages();
  await enteredPromise;
  const closing = harness.client.close();
  release();
  assert.deepEqual(await pending, { status: 'STOPPED', messages: [], rejectedCount: 0 });
  await closing;
  assert.equal(memory.state.closed, 1);
});

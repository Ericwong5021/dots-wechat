import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeixinTextClient, WEIXIN_TEXT_LIMITS } from './client.mjs';

const START = 1790800000000;
const BOT = 'synthetic-bot';
const OWNER = 'synthetic-owner';
const oldCursor = 'synthetic-old-cursor';
const incoming = (id, overrides = {}) => ({ message_id: String(id), from_user_id: OWNER, to_user_id: BOT, message_type: 1, message_state: 2, context_token: 'synthetic-context', item_list: [{ type: 1, text_item: { text: 'synthetic-body' } }], ...overrides });
const entry = (index, outcome = 'API_ACCEPTED') => ({ id: String(index), clientId: `dots-00000000-0000-0000-0000-${String(index).padStart(12, '0')}`, createdAtMs: START, outcome, ...(outcome === null ? { text: 'synthetic-body', contextToken: 'synthetic-context' } : {}) });
const initialState = entries => ({ schemaVersion: 1, botId: BOT, ownerUserId: OWNER, cursor: oldCursor, lastObservedAtMs: START, entries });
const updates = (msgs, cursor = 'synthetic-next-cursor') => new Response(JSON.stringify({ ret: 0, msgs, get_updates_buf: cursor }));

function store(initial) {
  let disk = structuredClone(initial);
  const state = { failSave: false, saveHook: null };
  const writes = [];
  return {
    state,
    writes,
    saved: () => structuredClone(disk),
    adapter: {
      async load() { return structuredClone(disk); },
      async save(next) {
        if (state.saveHook) await state.saveHook(next);
        if (state.failSave) throw new Error('synthetic-save-failure');
        disk = structuredClone(next);
        writes.push(structuredClone(next));
      },
      async close() {}
    }
  };
}

function setup(queue, memory) {
  const clock = { value: START };
  const calls = [];
  const client = createWeixinTextClient({ enabled: true, botToken: 'synthetic-never-live-token', botId: BOT, ownerUserId: OWNER, now: () => clock.value - START, wallNow: () => clock.value, ...(memory ? { stateStore: memory.adapter } : {}), fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    assert.ok(queue.length, 'Unexpected synthetic fetch');
    const response = queue.shift();
    return typeof response === 'function' ? response() : response;
  } });
  return { client, clock, calls };
}

test('shared provider and retained limits remain immutable and bounded', () => {
  assert.deepEqual(WEIXIN_TEXT_LIMITS, { providerBatchMessages: 128, retainedMessages: 1024 });
  assert.ok(Object.isFrozen(WEIXIN_TEXT_LIMITS));
});

const rejectedBatches = [
  ['duplicate retained IDs', () => Array.from({ length: 25 }, (_, index) => incoming(index))],
  ['foreign owner', () => Array.from({ length: 25 }, (_, index) => incoming(2000 + index, { from_user_id: 'synthetic-stranger' }))],
  ['media records', () => Array.from({ length: 25 }, (_, index) => incoming(2000 + index, { item_list: [{ type: 2, image_item: {} }] }))],
  ['invalid text', () => Array.from({ length: 25 }, (_, index) => incoming(2000 + index, { item_list: [{ type: 1, text_item: { text: '' } }] }))],
];

for (const [name, batch] of rejectedBatches) {
  test(`1000 retained entries do not block 25 ${name}`, async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => entry(index, index === 0 ? 'OUTCOME_UNKNOWN' : 'API_ACCEPTED'));
    const memory = store(initialState(entries));
    const harness = setup([updates(batch()), updates([], 'synthetic-after-rejected')], memory);
    const result = await harness.client.getUpdates();
    assert.deepEqual(result, { status: 'OK', messages: [], rejectedCount: 25 });
    assert.deepEqual(memory.saved().entries, entries);
    assert.equal(memory.saved().cursor, 'synthetic-next-cursor');
    await harness.client.getUpdates();
    assert.equal(harness.calls[1].get_updates_buf, 'synthetic-next-cursor');
    await harness.client.close();
  });
}

test('mixed batch counts only unique new valid owner records and persists with its cursor', async () => {
  const memory = store(initialState(Array.from({ length: 1000 }, (_, index) => entry(index))));
  const batch = [
    ...Array.from({ length: 10 }, (_, index) => incoming(index)),
    ...Array.from({ length: 10 }, (_, index) => incoming(2000 + index, { from_user_id: 'synthetic-stranger' })),
    ...Array.from({ length: 4 }, (_, index) => incoming(3000 + index)),
    incoming(3000),
  ];
  const harness = setup([updates(batch)], memory);
  const result = await harness.client.getUpdates();
  assert.equal(result.status, 'OK');
  assert.equal(result.rejectedCount, 21);
  assert.deepEqual(result.messages.map(message => message.messageId), ['3000', '3001', '3002', '3003']);
  assert.equal(memory.saved().entries.length, 1004);
  assert.equal(memory.saved().cursor, 'synthetic-next-cursor');
  assert.deepEqual(memory.saved().entries.slice(-4).map(record => record.id), ['3000', '3001', '3002', '3003']);
  await harness.client.close();
});

for (const durable of [false, true]) {
  test(`${durable ? 'durable' : 'memory'} overflow accepts no prefix and preserves cursor for later retry`, async () => {
    const memory = durable ? store(initialState(Array.from({ length: 1000 }, (_, index) => entry(index)))) : undefined;
    const queue = [];
    if (!durable) {
      for (let offset = 0; offset < 1000; offset += 128) queue.push(updates(Array.from({ length: Math.min(128, 1000 - offset) }, (_, index) => incoming(offset + index)), oldCursor));
    }
    queue.push(updates(Array.from({ length: 25 }, (_, index) => incoming(2000 + index)), 'synthetic-must-not-commit'));
    queue.push(updates(Array.from({ length: 24 }, (_, index) => incoming(2000 + index)), 'synthetic-final-cursor'));
    const harness = setup(queue, memory);
    if (!durable) for (let offset = 0; offset < 1000; offset += 128) assert.equal((await harness.client.getUpdates()).status, 'OK');
    assert.deepEqual(await harness.client.getUpdates(), { status: 'SESSION_LIMIT', messages: [], rejectedCount: 0 });
    if (durable) {
      assert.equal(memory.saved().entries.length, 1000);
      assert.equal(memory.saved().cursor, oldCursor);
      assert.equal((await harness.client.pendingMessages()).messages.length, 0);
    }
    const retry = await harness.client.getUpdates();
    assert.equal(harness.calls.at(-1).get_updates_buf, oldCursor);
    assert.equal(retry.status, 'OK');
    assert.equal(retry.messages.length, 24);
    assert.equal(retry.rejectedCount, 0);
    if (durable) {
      assert.equal(memory.saved().entries.length, 1024);
      assert.equal(memory.saved().cursor, 'synthetic-final-cursor');
    }
    const callCount = harness.calls.length;
    assert.equal((await harness.client.getUpdates()).status, 'SESSION_LIMIT');
    assert.equal(harness.calls.length, callCount);
    await harness.client.close();
  });
}

test('ongoing polls persist expired pending payload cleanup before the next GET and retain tombstones', async () => {
  const entries = [entry(0, null), entry(1, 'OUTCOME_UNKNOWN'), entry(2, 'API_ACCEPTED')];
  const memory = store(initialState(entries));
  const harness = setup([() => {
    const saved = memory.saved();
    assert.equal(saved.cursor, oldCursor);
    assert.deepEqual(saved.entries[0], entry(0, 'EXPIRED_CONTEXT'));
    assert.equal(saved.entries[1].outcome, 'OUTCOME_UNKNOWN');
    assert.equal(saved.entries[2].outcome, 'API_ACCEPTED');
    return updates([incoming(0), incoming(1), incoming(2)], 'synthetic-after-expiry');
  }], memory);
  const inbound = (await harness.client.pendingMessages()).messages[0];
  harness.clock.value += 600000;
  const result = await harness.client.getUpdates();
  assert.deepEqual(result, { status: 'OK', messages: [], rejectedCount: 3 });
  assert.equal(memory.saved().entries.length, 3);
  assert.equal(memory.saved().cursor, 'synthetic-after-expiry');
  assert.deepEqual(await harness.client.sendText({ inbound, text: 'synthetic-late-reply' }), { status: 'ALREADY_ATTEMPTED', attempted: false, outcome: 'EXPIRED_CONTEXT' });
  assert.equal(harness.calls.length, 1);
  await harness.client.close();
});

test('expiration write failure prevents GET and cursor advancement', async () => {
  const memory = store(initialState([entry(0, null)]));
  const harness = setup([], memory);
  await harness.client.initialize();
  harness.clock.value += 600000;
  memory.state.failSave = true;
  assert.equal((await harness.client.getUpdates()).status, 'STORAGE_BLOCKED');
  assert.equal(harness.calls.length, 0);
  assert.equal(memory.saved().cursor, oldCursor);
  assert.equal(memory.saved().entries[0].outcome, null);
  assert.equal((await harness.client.pendingMessages()).status, 'STORAGE_BLOCKED');
  await harness.client.close();
});

test('pending expiration during GET is persisted before the new response cursor', async () => {
  const memory = store(initialState([entry(0, null), entry(1, 'OUTCOME_UNKNOWN')]));
  const harness = setup([() => {
    assert.equal(memory.saved().entries[0].outcome, null);
    harness.clock.value += 600000;
    return updates([incoming(2000)], 'synthetic-new-cursor');
  }], memory);
  await harness.client.initialize();
  const startWriteCount = memory.writes.length;
  const result = await harness.client.getUpdates();
  assert.equal(result.status, 'OK');
  assert.equal(result.messages.length, 1);
  const writes = memory.writes.slice(startWriteCount);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].cursor, oldCursor);
  assert.deepEqual(writes[0].entries[0], entry(0, 'EXPIRED_CONTEXT'));
  assert.equal(writes[0].entries[1].outcome, 'OUTCOME_UNKNOWN');
  assert.equal(writes[1].cursor, 'synthetic-new-cursor');
  assert.equal(writes[1].entries[0].outcome, 'EXPIRED_CONTEXT');
  assert.equal(writes[1].entries[2].id, '2000');
  assert.equal(writes[1].entries[2].createdAtMs, START + 600000);
  await harness.client.close();
});

test('post-response expiration save failure releases no new messages or cursor and retains UNKNOWN', async () => {
  const memory = store(initialState([entry(0, null), entry(1, 'OUTCOME_UNKNOWN')]));
  const harness = setup([() => {
    harness.clock.value += 600000;
    memory.state.failSave = true;
    return updates([incoming(2000)], 'synthetic-must-not-commit');
  }], memory);
  await harness.client.initialize();
  assert.deepEqual(await harness.client.getUpdates(), { status: 'STORAGE_BLOCKED', messages: [], rejectedCount: 0 });
  assert.equal(memory.saved().cursor, oldCursor);
  assert.equal(memory.saved().entries.length, 2);
  assert.equal(memory.saved().entries[1].outcome, 'OUTCOME_UNKNOWN');
  assert.equal((await harness.client.getUpdates()).status, 'STORAGE_BLOCKED');
  assert.equal(harness.calls.length, 1);
  await harness.client.close();
});

test('full ledger still cleans expired payload before returning SESSION_LIMIT without GET', async () => {
  const memory = store(initialState(Array.from({ length: 1024 }, (_, index) => entry(index, index === 0 ? null : 'OUTCOME_UNKNOWN'))));
  const harness = setup([], memory);
  await harness.client.initialize();
  harness.clock.value += 600000;
  assert.equal((await harness.client.getUpdates()).status, 'SESSION_LIMIT');
  assert.equal(harness.calls.length, 0);
  assert.equal(memory.saved().entries.length, 1024);
  assert.deepEqual(memory.saved().entries[0], entry(0, 'EXPIRED_CONTEXT'));
  assert.ok(memory.saved().entries.slice(1).every(record => record.outcome === 'OUTCOME_UNKNOWN'));
  assert.equal(memory.saved().cursor, oldCursor);
  await harness.client.close();
});

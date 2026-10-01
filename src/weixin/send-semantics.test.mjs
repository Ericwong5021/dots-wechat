import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createWeixinTextClient, parseWeixinJson } from './client.mjs';

const START = 1790800000000;
const BOT = 'synthetic-bot';
const OWNER = 'synthetic-owner';
const TOKEN = 'synthetic-token-never-live';
const CONTEXT = 'synthetic-context';
const REPLY = 'synthetic reply';
const SERVER_ID = '18446744073709551615';
const OLD_CLIENT = 'dots-89a744bc-72f8-47a7-b21b-0445c42317f5';

function incoming() {
  return { message_id: '42', from_user_id: OWNER, to_user_id: BOT, message_type: 1, message_state: 2, context_token: CONTEXT, item_list: [{ type: 1, text_item: { text: 'synthetic test' } }] };
}

function response(raw, status = 200) {
  return new Response(raw, { status, headers: { 'content-type': 'application/octet-stream' } });
}

function updates() {
  return response(JSON.stringify({ msgs: [incoming()], get_updates_buf: 'synthetic-cursor' }));
}

function setup(queue = [], stateStore) {
  const calls = [];
  const client = createWeixinTextClient({
    enabled: true,
    botToken: TOKEN,
    botId: BOT,
    ownerUserId: OWNER,
    stateStore,
    now: () => 0,
    wallNow: () => START,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const next = queue.shift();
      assert.ok(next, 'Unexpected synthetic fetch');
      return typeof next === 'function' ? next() : next;
    }
  });
  return { client, calls };
}

function memoryStore(initial = null) {
  let saved = structuredClone(initial);
  const writes = [];
  let loads = 0;
  return {
    store: {
      async load() { loads++; return structuredClone(saved); },
      async save(next) { saved = structuredClone(next); writes.push(structuredClone(next)); },
      async close() {}
    },
    saved: () => structuredClone(saved),
    writes,
    loads: () => loads
  };
}

const accepted = [
  ['small wire integer', '{"message_id":1}'],
  ['safe boundary wire integer', '{"message_id":9007199254740991}'],
  ['unsafe JS integer preserved losslessly', '{"message_id":9007199254740993}'],
  ['maximum wire uint64 preserved losslessly', '{"message_id":18446744073709551615}'],
  ['canonical string uint64', '{"message_id":"18446744073709551615"}'],
  ['escaped property name', '{"message\\u005fid":18446744073709551615}'],
  ['explicit success without ID', '{"ret":0}'],
  ['explicit success and zero errcode', '{"ret":0,"errcode":0}']
];

for (const [label, raw] of accepted) {
  test(`accepts ${label} without claiming delivery or permitting duplicate POST`, async () => {
    const { client, calls } = setup([updates(), response(raw)]);
    const inbound = (await client.getUpdates()).messages[0];
    const result = await client.sendText({ inbound, text: REPLY });
    assert.deepEqual(result, { status: 'API_ACCEPTED', attempted: true, deliveryConfirmed: false });
    assert.deepEqual(await client.sendText({ inbound, text: 'changed reply' }), { status: 'ALREADY_ATTEMPTED', attempted: false, outcome: 'API_ACCEPTED' });
    assert.equal(calls.filter(call => call.url.endsWith('/sendmessage')).length, 1);
    assert.equal(calls[1].body.msg.to_user_id, OWNER);
    assert.equal(calls[1].body.msg.context_token, CONTEXT);
    for (const secret of [TOKEN, CONTEXT, SERVER_ID]) {
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.ok(!inspect(result).includes(secret));
    }
    await client.close();
  });
}

const unknown = [
  ['empty object', '{}'],
  ['null ID', '{"message_id":null}'],
  ['empty ID', '{"message_id":""}'],
  ['zero numeric ID', '{"message_id":0}'],
  ['zero string ID', '{"message_id":"0"}'],
  ['negative wire integer', '{"message_id":-1}'],
  ['fraction', '{"message_id":1.5}'],
  ['integer-looking fraction', '{"message_id":1.0}'],
  ['exponential notation', '{"message_id":1e3}'],
  ['overflow wire uint64', '{"message_id":18446744073709551616}'],
  ['overflow string uint64', '{"message_id":"18446744073709551616"}'],
  ['negative string', '{"message_id":"-1"}'],
  ['noncanonical leading zero', '{"message_id":"01"}'],
  ['whitespace padded ID', '{"message_id":" 1"}'],
  ['signed positive ID', '{"message_id":"+1"}'],
  ['boolean ID', '{"message_id":true}'],
  ['object ID', '{"message_id":{}}'],
  ['array ID', '{"message_id":[1]}'],
  ['ID nested rather than top-level', '{"result":{"message_id":1}}'],
  ['null ret with valid ID', '{"ret":null,"message_id":1}'],
  ['string ret with valid ID', '{"ret":"0","message_id":1}'],
  ['boolean ret with valid ID', '{"ret":false,"message_id":1}'],
  ['fraction ret with valid ID', '{"ret":0.5,"message_id":1}'],
  ['null errcode with valid ID', '{"errcode":null,"message_id":1}'],
  ['string errcode with valid ID', '{"errcode":"0","message_id":1}'],
  ['only errcode zero without documented send success ret', '{"errcode":0,"message_id":1}'],
  ['malformed errcode blocks explicit ret success', '{"ret":0,"errcode":null,"message_id":1}'],
  ['malformed JSON', '{"message_id":']
];

for (const [label, raw] of unknown) {
  test(`keeps ${label} unknown and never automatically retries`, async () => {
    const { client, calls } = setup([updates(), response(raw)]);
    const inbound = (await client.getUpdates()).messages[0];
    assert.deepEqual(await client.sendText({ inbound, text: REPLY }), { status: 'OUTCOME_UNKNOWN', attempted: true, deliveryConfirmed: false });
    assert.deepEqual(await client.sendText({ inbound, text: REPLY }), { status: 'ALREADY_ATTEMPTED', attempted: false, outcome: 'OUTCOME_UNKNOWN' });
    assert.equal(calls.length, 2);
    await client.close();
  });
}

const rejected = [
  ['ret', '{"ret":9,"message_id":18446744073709551615}', 'REJECTED'],
  ['errcode', '{"errcode":9,"message_id":18446744073709551615}', 'REJECTED'],
  ['errcode despite ret success', '{"ret":0,"errcode":9,"message_id":1}', 'REJECTED'],
  ['ret despite malformed errcode', '{"ret":9,"errcode":null,"message_id":1}', 'REJECTED'],
  ['errcode despite malformed ret', '{"ret":null,"errcode":9,"message_id":1}', 'REJECTED'],
  ['ret session expiry', '{"ret":-14,"message_id":1}', 'SESSION_EXPIRED'],
  ['errcode session expiry', '{"ret":0,"errcode":-14,"message_id":1}', 'SESSION_EXPIRED']
];

for (const [label, raw, expected] of rejected) {
  test(`preserves ${label} before considering message ID`, async () => {
    const { client, calls } = setup([updates(), response(raw)]);
    const inbound = (await client.getUpdates()).messages[0];
    assert.deepEqual(await client.sendText({ inbound, text: REPLY }), { status: expected, attempted: true, deliveryConfirmed: false });
    const duplicate = await client.sendText({ inbound, text: REPLY });
    assert.equal(duplicate.attempted, false);
    assert.equal(calls.length, 2);
    await client.close();
  });
}

test('HTTP failure cannot become accepted through a valid message ID', async () => {
  const { client, calls } = setup([updates(), response('{"message_id":1}', 500)]);
  const inbound = (await client.getUpdates()).messages[0];
  assert.equal((await client.sendText({ inbound, text: REPLY })).status, 'OUTCOME_UNKNOWN');
  assert.equal(calls.length, 2);
  await client.close();
});

test('large wire IDs retain every digit before success-shape validation', () => {
  for (const id of ['9007199254740993', '18446744073709551614', SERVER_ID]) {
    assert.equal(parseWeixinJson(`{"message_id":${id}}`).message_id, id);
  }
});

test('constructing the candidate does not load or rewrite historical state', async () => {
  const memory = memoryStore({ synthetic: 'untouched' });
  const { client, calls } = setup([], memory.store);
  assert.equal(memory.loads(), 0);
  assert.equal(memory.writes.length, 0);
  assert.equal(calls.length, 0);
  await client.close();
  assert.deepEqual(memory.saved(), { synthetic: 'untouched' });
});

for (const [outcome, raw] of [['API_ACCEPTED', '{"message_id":18446744073709551615}'], ['OUTCOME_UNKNOWN', '{"message_id":null}']]) {
  test(`persists ${outcome} for new sends while preserving historical UNKNOWN and restart deduplication`, async () => {
    const oldEntry = { id: '41', clientId: OLD_CLIENT, createdAtMs: START, outcome: 'OUTCOME_UNKNOWN' };
    const historical = { schemaVersion: 1, botId: BOT, ownerUserId: OWNER, cursor: 'prior-cursor', lastObservedAtMs: START, entries: [oldEntry] };
    const memory = memoryStore(historical);
    const first = setup([updates(), () => {
      assert.equal(memory.saved().entries[1].outcome, 'IN_FLIGHT');
      assert.deepEqual(memory.saved().entries[0], oldEntry);
      return response(raw);
    }], memory.store);
    const inbound = (await first.client.getUpdates()).messages[0];
    assert.equal(first.calls[0].body.get_updates_buf, 'prior-cursor');
    assert.equal((await first.client.sendText({ inbound, text: REPLY })).status, outcome);
    assert.equal(memory.saved().entries[1].outcome, outcome);
    assert.deepEqual(memory.saved().entries[0], oldEntry);
    assert.deepEqual(Object.keys(memory.saved().entries[1]).sort(), ['clientId', 'createdAtMs', 'id', 'outcome']);
    assert.ok(!JSON.stringify(memory.saved()).includes(SERVER_ID));
    assert.ok(!JSON.stringify(memory.saved()).includes(TOKEN));
    await first.client.close();
    const afterClose = memory.saved();
    const restarted = setup([updates()], memory.store);
    assert.equal((await restarted.client.pendingMessages()).messages.length, 0);
    assert.deepEqual(memory.saved(), afterClose);
    const duplicate = await restarted.client.getUpdates();
    assert.equal(duplicate.messages.length, 0);
    assert.equal(duplicate.rejectedCount, 1);
    assert.deepEqual(memory.saved(), afterClose);
    assert.equal(restarted.calls.filter(call => call.url.endsWith('/sendmessage')).length, 0);
    for (const written of memory.writes) assert.deepEqual(written.entries[0], oldEntry);
    await restarted.client.close();
  });
}

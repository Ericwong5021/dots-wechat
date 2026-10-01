import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createWeixinTextClient, parseWeixinJson } from './client.mjs';

const BOT = 'synthetic-bot';
const OWNER = 'synthetic-owner';
const TOKEN = 'synthetic-token-never-live';
const CONTEXT = 'synthetic-private-context';
const ID = '18446744073709551615';

function incoming(overrides = {}) {
  return { message_id: ID, from_user_id: OWNER, to_user_id: BOT, message_type: 1, message_state: 2, context_token: CONTEXT, item_list: [{ type: 1, text_item: { text: '随机文本：测试' } }], ...overrides };
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function setup(replies = [], options = {}) {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const reply = queue.shift();
    if (typeof reply === 'function') return reply(url, init);
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error('UNEXPECTED_FETCH');
    return reply;
  };
  const client = createWeixinTextClient({ enabled: true, botToken: TOKEN, botId: BOT, ownerUserId: OWNER, fetchImpl, ...options });
  return { client, calls, queue };
}

function updates(messages = [incoming()], cursor = 'synthetic-cursor') {
  return json({ ret: 0, msgs: messages, get_updates_buf: cursor });
}

async function prepare(reply, options = {}) {
  const harness = setup([updates(), reply], options);
  const poll = await harness.client.getUpdates();
  assert.equal(poll.status, 'OK');
  return { ...harness, inbound: poll.messages[0] };
}

test('default disabled is inert without credentials or accidental fetch', async () => {
  let calls = 0;
  const client = createWeixinTextClient({ fetchImpl: () => { calls++; throw new Error('NETWORK_FORBIDDEN'); } });
  assert.equal((await client.getUpdates()).status, 'DISABLED');
  assert.equal((await client.sendText({})).status, 'DISABLED');
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(client), '{}');
});

test('configuration rejects absent credentials, unsafe headers and invalid deadlines without secrets', () => {
  for (const overrides of [{ botToken: undefined }, { botToken: 'secret\r\nInjected: true' }, { botId: '' }, { ownerUserId: 'owner with space' }, { timeoutMs: 0 }, { pollTimeoutMs: Infinity }, { contextTtlMs: 600001 }, { fetchImpl: null }]) {
    assert.throws(() => setup([], overrides), error => error.message === 'INVALID_CONFIGURATION');
  }
});

test('exact uint64 numeric message IDs are parsed before rounding, including escaped property name', () => {
  const parsed = parseWeixinJson('{"message_id":18446744073709551615,"nested":{"message\\u005fid":9007199254740993},"text":"\\\"message_id\\\":18446744073709551615"}');
  assert.equal(parsed.message_id, ID);
  assert.equal(parsed.nested.message_id, '9007199254740993');
  assert.equal(parsed.text, '"message_id":18446744073709551615');
  assert.equal(parseWeixinJson('{"message_id":42}').message_id, '42');
  for (const raw of ['-1', '1.5', '1e3', '18446744073709551616']) assert.equal(parseWeixinJson(`{"message_id":${raw}}`).message_id, null);
  assert.throws(() => parseWeixinJson('{"message_id":01}'));
});

test('official fixed HTTPS endpoint, authentication and protocol metadata; cursor retained only in memory', async () => {
  const { client, calls } = setup([updates(), updates([], 'next-synthetic-cursor')]);
  const result = await client.getUpdates();
  assert.equal(result.messages[0].messageId, ID);
  assert.equal(result.messages[0].contextToken, CONTEXT);
  assert.ok(Object.isFrozen(result.messages[0]));
  assert.equal(calls[0].url, 'https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(calls[0].init.headers['iLink-App-Id'], 'bot');
  assert.equal(calls[0].init.headers['iLink-App-ClientVersion'], '132105');
  const uin = Buffer.from(calls[0].init.headers['X-WECHAT-UIN'], 'base64').toString();
  assert.match(uin, /^\d+$/);
  assert.ok(Number(uin) >= 0 && Number(uin) <= 4294967295);
  assert.deepEqual(calls[0].body, { get_updates_buf: '', base_info: { channel_version: '2.4.9', bot_agent: 'DotsWatch/0.1.0' } });
  await client.getUpdates();
  assert.equal(calls[1].body.get_updates_buf, 'synthetic-cursor');
  for (const secret of [BOT, OWNER, CONTEXT, TOKEN, ID, '随机文本']) {
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!inspect(result).includes(secret));
  }
});

test('wire numeric uint64 ID remains exact through getUpdates', async () => {
  const raw = JSON.stringify({ ret: 0, msgs: [incoming()], get_updates_buf: '' }).replace(`"message_id":"${ID}"`, `"message_id":${ID}`);
  const { client } = setup([new Response(raw)]);
  assert.equal((await client.getUpdates()).messages[0].messageId, ID);
});

const rejectedInputs = {
  'other sender': { from_user_id: 'another-peer' },
  'other bot': { to_user_id: 'another-bot' },
  'null receiver': { to_user_id: null },
  'group': { group_id: 'group-id' },
  'null group': { group_id: null },
  'bot echo': { message_type: 2 },
  'unfinished': { message_state: 1 },
  'missing context': { context_token: undefined },
  'empty context': { context_token: '' },
  'whitespace context': { context_token: ' ' },
  'uint64 overflow': { message_id: '18446744073709551616' },
  'negative ID': { message_id: '-1' },
  'fraction ID': { message_id: '1.5' },
  'noncanonical ID': { message_id: '001' },
  'missing ID': { message_id: undefined },
  'deleted': { delete_time_ms: 1 },
  'voice transcript': { item_list: [{ type: 3, voice_item: { text: 'hello' } }] },
  'media caption': { item_list: [{ type: 1, text_item: { text: 'caption' } }, { type: 2, image_item: {} }] },
  'empty text': { item_list: [{ type: 1, text_item: { text: ' ' } }] },
  'unpaired surrogate': { item_list: [{ type: 1, text_item: { text: '\ud800' } }] },
  'oversized text': { item_list: [{ type: 1, text_item: { text: 'x'.repeat(4001) } }] }
};
for (const [label, override] of Object.entries(rejectedInputs)) {
  test(`inbound rejects ${label} without emitting private data`, async () => {
    const { client } = setup([updates([incoming(override)])]);
    const result = await client.getUpdates();
    assert.equal(result.status, 'OK');
    assert.equal(result.messages.length, 0);
    assert.equal(result.rejectedCount, 1);
  });
}

test('safe numeric ID accepted and duplicate ID cannot replace reply context or retransmit', async () => {
  const { client, calls } = setup([updates([incoming({ message_id: 42 })]), updates([incoming({ message_id: 42, context_token: 'changed-context' })]), json({ ret: 0 })]);
  const first = (await client.getUpdates()).messages[0];
  assert.equal(first.messageId, '42');
  assert.equal((await client.getUpdates()).messages.length, 0);
  assert.equal((await client.sendText({ inbound: first, text: 'reply' })).status, 'API_ACCEPTED');
  assert.equal(calls[2].body.msg.context_token, CONTEXT);
});

test('sendText only accepts instance-owned immutable inbound; foreign fields cannot reroute', async () => {
  const { client, inbound, calls } = await prepare(json({ ret: 0 }));
  assert.equal((await client.sendText({ inbound: { ...inbound }, text: 'reply' })).status, 'INVALID_INBOUND');
  assert.equal((await client.sendText({ inbound, text: 'reply', peerId: 'attacker' })).status, 'INVALID_ARGUMENTS');
  assert.equal((await client.sendText({ inbound, text: 'reply', contextToken: 'attacker' })).status, 'INVALID_ARGUMENTS');
  const foreign = setup([]).client;
  assert.equal((await foreign.sendText({ inbound, text: 'reply' })).status, 'INVALID_INBOUND');
  assert.throws(() => { inbound.peerId = 'attacker'; }, TypeError);
  const result = await client.sendText({ inbound, text: '现有 dot 的文本回复' });
  assert.deepEqual(result, { status: 'API_ACCEPTED', attempted: true, deliveryConfirmed: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  const sent = calls[1].body.msg;
  assert.equal(sent.to_user_id, OWNER);
  assert.equal(sent.from_user_id, '');
  assert.equal(sent.context_token, CONTEXT);
  assert.equal(sent.message_type, 2);
  assert.equal(sent.message_state, 2);
  assert.match(sent.client_id, /^dots-[0-9a-f-]{36}$/);
  assert.deepEqual(sent.item_list, [{ type: 1, text_item: { text: '现有 dot 的文本回复' } }]);
  assert.equal((await client.sendText({ inbound, text: 'same or changed reply' })).status, 'ALREADY_ATTEMPTED');
  assert.equal(calls.length, 2);
});

test('outbound Unicode and byte budgets reject before consuming send capability', async () => {
  const { client, inbound, calls } = await prepare(json({ ret: 0 }));
  for (const text of ['', ' ', '\udfff', 'x'.repeat(801), '中'.repeat(683), null]) {
    assert.equal((await client.sendText({ inbound, text })).status, 'INVALID_TEXT');
  }
  assert.equal(calls.length, 1);
  assert.equal((await client.sendText({ inbound, text: '中'.repeat(682) })).status, 'API_ACCEPTED');
});

const outcomes = [
  ['explicit reject', () => json({ ret: 9, errmsg: `${TOKEN} ${CONTEXT}` }), 'REJECTED'],
  ['errcode reject', () => json({ ret: 0, errcode: 9 }), 'REJECTED'],
  ['absent ret', () => json({}), 'OUTCOME_UNKNOWN'],
  ['string ret', () => json({ ret: '0' }), 'OUTCOME_UNKNOWN'],
  ['invalid errcode', () => json({ ret: 0, errcode: null }), 'OUTCOME_UNKNOWN'],
  ['network failure', () => new Error(`${TOKEN} ${CONTEXT}`), 'OUTCOME_UNKNOWN'],
  ['server failure', () => json({ ret: 0 }, { status: 500 }), 'OUTCOME_UNKNOWN'],
  ['redirect', () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid/' } }), 'OUTCOME_UNKNOWN'],
  ['broken JSON', () => new Response('{'), 'OUTCOME_UNKNOWN'],
  ['huge body', () => new Response('x'.repeat(262145)), 'OUTCOME_UNKNOWN'],
  ['lying length', () => new Response('{}', { headers: { 'content-length': '262145' } }), 'OUTCOME_UNKNOWN'],
  ['invalid utf8', () => new Response(new Uint8Array([255])), 'OUTCOME_UNKNOWN']
];
for (const [label, response, expected] of outcomes) {
  test(`${label}: redact and never automatically resend`, async () => {
    const { client, inbound, calls } = await prepare(response());
    const result = await client.sendText({ inbound, text: 'reply' });
    assert.equal(result.status, expected);
    assert.equal(result.deliveryConfirmed, false);
    for (const secret of [TOKEN, CONTEXT, BOT, OWNER, ID]) assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal((await client.sendText({ inbound, text: 'reply again' })).status, 'ALREADY_ATTEMPTED');
    assert.equal(calls.length, 2);
  });
}

test('timeout includes stalled response body and does not retry', async () => {
  const body = new ReadableStream({ start() {} });
  const { client, inbound, calls } = await prepare(new Response(body), { timeoutMs: 10 });
  const start = performance.now();
  const result = await client.sendText({ inbound, text: 'reply' });
  assert.equal(result.status, 'OUTCOME_UNKNOWN');
  assert.ok(performance.now() - start < 1000);
  assert.equal(calls[1].init.signal.aborted, true);
  assert.equal((await client.sendText({ inbound, text: 'reply' })).status, 'ALREADY_ATTEMPTED');
  assert.equal(calls.length, 2);
});

test('concurrent send has one client ID and one POST', async () => {
  let resolveSend;
  const pending = new Promise(resolve => { resolveSend = resolve; });
  const { client, inbound, calls } = await prepare(() => pending);
  const first = client.sendText({ inbound, text: 'first' });
  const second = await client.sendText({ inbound, text: 'second' });
  assert.deepEqual(second, { status: 'ALREADY_ATTEMPTED', attempted: false, outcome: 'IN_FLIGHT' });
  resolveSend(json({ ret: 0 }));
  assert.equal((await first).status, 'API_ACCEPTED');
  assert.equal(calls.length, 2);
});

test('poll overlap is rejected; timeout cannot falsely claim new messages', async () => {
  const { client, calls } = setup([() => new Promise(() => {})], { pollTimeoutMs: 10 });
  const first = client.getUpdates();
  assert.equal((await client.getUpdates()).status, 'BUSY');
  assert.deepEqual(await first, { status: 'TIMEOUT', messages: [], rejectedCount: 0 });
  assert.equal(calls.length, 1);
});

for (const field of ['ret', 'errcode']) {
  test(`-14 in ${field} closes poll session; never relogins`, async () => {
    const { client, calls } = setup([json({ [field]: -14, errmsg: TOKEN })]);
    assert.equal((await client.getUpdates()).status, 'SESSION_EXPIRED');
    assert.equal((await client.getUpdates()).status, 'SESSION_EXPIRED');
    assert.equal((await client.sendText({})).status, 'SESSION_EXPIRED');
    assert.equal(calls.length, 1);
  });
}

test('-14 while sending stops all future requests', async () => {
  const { client, inbound, calls } = await prepare(json({ ret: -14 }));
  assert.equal((await client.sendText({ inbound, text: 'reply' })).status, 'SESSION_EXPIRED');
  assert.equal((await client.getUpdates()).status, 'SESSION_EXPIRED');
  assert.equal(calls.length, 2);
});

test('context expiration and clock reversal reject before HTTP', async () => {
  for (const shift of [600000, -1]) {
    let clock = 1000;
    const { client, inbound, calls } = await prepare(json({ ret: 0 }), { now: () => clock });
    clock += shift;
    assert.equal((await client.sendText({ inbound, text: 'reply' })).status, 'EXPIRED_CONTEXT');
    assert.equal(calls.length, 1);
  }
});

test('close invalidates in-flight response and all retained inbound capabilities', async () => {
  let resolveSend;
  const pending = new Promise(resolve => { resolveSend = resolve; });
  const { client, inbound, calls } = await prepare(() => pending);
  const first = client.sendText({ inbound, text: 'reply' });
  client.close();
  resolveSend(json({ ret: 0 }));
  assert.equal((await first).status, 'OUTCOME_UNKNOWN');
  assert.equal(calls[1].init.signal.aborted, true);
  assert.equal((await client.sendText({ inbound, text: 'reply' })).status, 'STOPPED');
  assert.equal((await client.getUpdates()).status, 'STOPPED');
});

test('invalid poll response never advances cursor', async () => {
  const { client, calls } = setup([json({ ret: 0, msgs: 'wrong', get_updates_buf: 'untrusted-cursor' }), updates([])]);
  assert.equal((await client.getUpdates()).status, 'PROTOCOL_ERROR');
  await client.getUpdates();
  assert.equal(calls[1].body.get_updates_buf, '');
});

test('session ledger is bounded and refuses rather than evicts send tombstones', async () => {
  const replies = [];
  for (let batch = 0; batch < 8; batch++) {
    replies.push(updates(Array.from({ length: 128 }, (_, index) => incoming({ message_id: String(batch * 128 + index) }))));
  }
  const { client, calls } = setup(replies);
  for (let batch = 0; batch < 8; batch++) assert.equal((await client.getUpdates()).messages.length, 128);
  assert.equal((await client.getUpdates()).status, 'SESSION_LIMIT');
  assert.equal(calls.length, 8);
});


test('runtime without source metadata rejects already-unsafe numeric IDs', () => {
  const parse = JSON.parse;
  JSON.parse = (raw, revive) => parse(raw, (key, value) => revive(key, value));
  try {
    assert.equal(parseWeixinJson('{"message_id":9007199254740993}').message_id, null);
    assert.equal(parseWeixinJson('{"message_id":42}').message_id, '42');
  } finally {
    JSON.parse = parse;
  }
});

test('malformed send arguments and accessors cannot consume capability or bypass text validation', async () => {
  const { client, inbound, calls } = await prepare(json({ ret: 0 }));
  for (const args of [null, [], 42, 'x']) assert.equal((await client.sendText(args)).status, 'INVALID_ARGUMENTS');
  let reads = 0;
  const args = { inbound, get text() { reads++; return 'reply'; } };
  assert.equal((await client.sendText(args)).status, 'INVALID_ARGUMENTS');
  assert.equal(reads, 0);
  assert.equal(calls.length, 1);
  assert.equal((await client.sendText({ inbound, text: 'reply' })).status, 'API_ACCEPTED');
});


for (const [label, receiver] of [['missing', undefined], ['empty', '']]) {
  test(`${label} inbound receiver keeps account-token binding and same-owner reply context`, async () => {
    const { client, calls } = setup([updates([incoming({ to_user_id: receiver })]), json({ ret: 0 })]);
    const result = await client.getUpdates();
    assert.equal(result.status, 'OK');
    assert.equal(result.rejectedCount, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].botId, BOT);
    assert.equal(result.messages[0].peerId, OWNER);
    assert.equal((await client.sendText({ inbound: result.messages[0], text: 'reply' })).status, 'API_ACCEPTED');
    assert.equal(calls[1].body.msg.to_user_id, OWNER);
    assert.equal(calls[1].body.msg.context_token, CONTEXT);
  });
}

test('nonempty receiver must match raw bot ID without suffix normalization', async () => {
  const botId = 'synthetic-bot@im.bot';
  const { client } = setup([updates([
    incoming({ message_id: '10', to_user_id: 'synthetic-bot-im-bot' }),
    incoming({ message_id: '11', to_user_id: botId })
  ])], { botId });
  const result = await client.getUpdates();
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, '11');
  assert.equal(result.messages[0].botId, botId);
});

test('explicitly successful empty poll may omit msgs and advances valid cursor', async () => {
  const { client, calls } = setup([json({ ret: 0, get_updates_buf: 'empty-poll-cursor' }), updates([])]);
  assert.deepEqual(await client.getUpdates(), { status: 'OK', messages: [], rejectedCount: 0 });
  await client.getUpdates();
  assert.equal(calls[1].body.get_updates_buf, 'empty-poll-cursor');
});

test('null and malformed msgs remain protocol errors without cursor changes', async () => {
  for (const msgs of [null, {}, 0, '']) {
    const { client, calls } = setup([json({ ret: 0, msgs, get_updates_buf: 'bad-cursor' }), updates([])]);
    assert.equal((await client.getUpdates()).status, 'PROTOCOL_ERROR');
    await client.getUpdates();
    assert.equal(calls[1].body.get_updates_buf, '');
  }
});

test('official omitted default success fields allow cursor-only empty poll', async () => {
  const { client, calls } = setup([json({ get_updates_buf: 'official-empty-cursor' }), updates([])]);
  assert.deepEqual(await client.getUpdates(), { status: 'OK', messages: [], rejectedCount: 0 });
  await client.getUpdates();
  assert.equal(calls[1].body.get_updates_buf, 'official-empty-cursor');
});

test('observed omitted ret and errcode preserve messages, cursor and duplicate suppression', async () => {
  const { client, calls } = setup([
    json({ msgs: [incoming()], get_updates_buf: 'first-official-cursor' }),
    json({ msgs: [incoming(), incoming({ message_id: '43' })], get_updates_buf: 'second-official-cursor' }),
    json({ msgs: [], get_updates_buf: 'third-official-cursor' })
  ]);
  const first = await client.getUpdates();
  assert.equal(first.status, 'OK');
  assert.equal(first.messages.length, 1);
  const second = await client.getUpdates();
  assert.equal(second.status, 'OK');
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].messageId, '43');
  assert.equal(second.rejectedCount, 1);
  await client.getUpdates();
  assert.deepEqual(calls.map(call => call.body.get_updates_buf), ['', 'first-official-cursor', 'second-official-cursor']);
});

test('HTTP 200 is not business success and rejected envelopes never advance cursor', async () => {
  const cases = [
    [{}, 'PROTOCOL_ERROR'],
    [{ errmsg: 'not a success envelope' }, 'PROTOCOL_ERROR'],
    [{ ret: 5, msgs: [], get_updates_buf: 'bad-cursor' }, 'REJECTED'],
    [{ errcode: 5, msgs: [], get_updates_buf: 'bad-cursor' }, 'REJECTED'],
    ...[null, '0', false, 0.5].map(ret => [{ ret, msgs: [], get_updates_buf: 'bad-cursor' }, 'PROTOCOL_ERROR']),
    [{ errcode: '0', msgs: [], get_updates_buf: 'bad-cursor' }, 'PROTOCOL_ERROR'],
    [{ msgs: null, get_updates_buf: 'bad-cursor' }, 'PROTOCOL_ERROR'],
    [{ msgs: [], get_updates_buf: null }, 'PROTOCOL_ERROR']
  ];
  for (const [body, status] of cases) {
    const { client, calls } = setup([updates([], 'confirmed-cursor'), json(body), updates([])]);
    await client.getUpdates();
    assert.equal((await client.getUpdates()).status, status);
    await client.getUpdates();
    assert.equal(calls[2].body.get_updates_buf, 'confirmed-cursor');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPrivateStateStore } from './private-state-store.mjs';
import { createWeixinTextClient } from './client.mjs';

test('real private store restores pending context and cursor, then prevents a second send after restart', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dots-private-integration-')));
  await chmod(directory, 0o700);
  const statePath = path.join(directory, 'state.json');
  const message = { message_id: '1234', from_user_id: 'fixture-owner', to_user_id: 'fixture-bot', message_type: 1, message_state: 2, context_token: 'fixture-reply-context', item_list: [{ type: 1, text_item: { text: 'fixture-pending-text' } }] };
  let count = 0;
  const sent = [];
  const fetchedCursors = [];
  const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/getupdates')) { fetchedCursors.push(body.get_updates_buf); return response({ msgs: [message], get_updates_buf: 'fixture-cursor-' + (++count) }); }
    sent.push(body); return response({ ret: 0 });
  };
  const openClient = async () => createWeixinTextClient({ enabled: true, botToken: 'fixture-bot-token-never-real', botId: 'fixture-bot', ownerUserId: 'fixture-owner', fetchImpl, stateStore: await createPrivateStateStore({ statePath }) });
  let client;
  try {
    client = await openClient();
    assert.equal((await client.getUpdates()).messages.length, 1);
    await client.close();
    client = await openClient();
    const pending = await client.pendingMessages();
    assert.equal(pending.messages.length, 1);
    assert.equal(pending.messages[0].text, 'fixture-pending-text');
    assert.equal((await client.sendText({ inbound: pending.messages[0], text: 'fixture-reply' })).status, 'API_ACCEPTED');
    await client.close();
    client = await openClient();
    assert.equal((await client.pendingMessages()).messages.length, 0);
    assert.equal((await client.getUpdates()).messages.length, 0);
    assert.equal((await client.sendText({ inbound: pending.messages[0], text: 'fixture-reply' })).attempted, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.context_token, 'fixture-reply-context');
    assert.deepEqual(fetchedCursors, ['', 'fixture-cursor-1']);
    const stored = await readFile(statePath, 'utf8');
    for (const secret of ['fixture-bot-token-never-real', 'fixture-reply-context', 'fixture-pending-text']) assert.equal(stored.includes(secret), false);
  } finally { await client?.close(); await rm(directory, { recursive: true, force: true }); }
});

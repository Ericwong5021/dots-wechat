import { randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

const ORIGIN = 'https://ilinkai.weixin.qq.com';
const VERSION = '2.4.9';
const VERSION_NUMBER = String((2 << 16) | (4 << 8) | 9);
const MAX_BODY_BYTES = 262144;
export const WEIXIN_TEXT_LIMITS = Object.freeze({ providerBatchMessages: 128, retainedMessages: 1024 });
const MAX_MESSAGES = WEIXIN_TEXT_LIMITS.providerBatchMessages;
const MAX_SESSION_MESSAGES = WEIXIN_TEXT_LIMITS.retainedMessages;
const UINT64_MAX = 18446744073709551615n;
const OUTCOMES = new Set(['IN_FLIGHT', 'OUTCOME_UNKNOWN', 'API_ACCEPTED', 'REJECTED', 'SESSION_EXPIRED', 'EXPIRED_CONTEXT']);

function opaque(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/u.test(value);
}

function validText(value, maxUnits, maxBytes) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxUnits && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function messageId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  return BigInt(value) <= UINT64_MAX ? value : null;
}

export function parseWeixinJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) throw new Error('INVALID_BODY');
  return JSON.parse(raw, (key, value, context) => {
    if (key !== 'message_id' || typeof value !== 'number') return value;
    return context?.source === undefined ? messageId(value) : messageId(context.source);
  });
}

function diagnostic(status, extra = {}) {
  return Object.freeze({ status, ...extra });
}

function pollResult(status, messages = [], rejectedCount = 0) {
  return diagnostic(status, { messages: Object.freeze(messages), rejectedCount });
}

function privateInbound(data) {
  const inbound = { ...data };
  Object.defineProperties(inbound, {
    toJSON: { value: () => ({ kind: 'private_weixin_inbound' }) },
    [inspect.custom]: { value: () => '[PrivateWeixinInbound]' }
  });
  return Object.freeze(inbound);
}

async function readBounded(response) {
  const declared = response.headers?.get('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error('INVALID_BODY');
  if (!response.body?.getReader) throw new Error('INVALID_BODY');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw new Error('INVALID_BODY');
      length += item.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error('INVALID_BODY');
      chunks.push(item.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
  } catch {
    void reader.cancel().catch(() => {});
    throw new Error('INVALID_BODY');
  } finally {
    reader.releaseLock();
  }
}

export function createWeixinTextClient(options = {}) {
  const { enabled = false, botId, ownerUserId, fetchImpl = globalThis.fetch, timeoutMs = 15000, pollTimeoutMs = 40000, contextTtlMs = 600000, now = () => performance.now(), wallNow = Date.now, stateStore } = options;
  let token = options.botToken;
  if (enabled !== false && enabled !== true) throw new Error('INVALID_CONFIGURATION');
  if (enabled && (!opaque(token) || !/^[\x21-\x7e]+$/.test(token) || !opaque(botId, 256) || !opaque(ownerUserId, 256) || typeof fetchImpl !== 'function')) throw new Error('INVALID_CONFIGURATION');
  for (const duration of [timeoutMs, pollTimeoutMs, contextTtlMs]) {
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 600000) throw new Error('INVALID_CONFIGURATION');
  }
  if (typeof now !== 'function' || typeof wallNow !== 'function') throw new Error('INVALID_CONFIGURATION');
  const durable = stateStore !== undefined;
  if (durable && (!stateStore || ['load', 'save', 'close'].some(key => typeof stateStore[key] !== 'function'))) throw new Error('INVALID_CONFIGURATION');
  let stopped = false;
  let sessionExpired = false;
  let polling = false;
  let cursor = '';
  let capabilities = new WeakMap();
  let ledger = new Map();
  let initialized = !durable;
  let storageBlocked = false;
  let lastObservedAtMs = 0;
  let operations = Promise.resolve();
  let closePromise;
  const active = new Set();

  function state() {
    if (!enabled) return 'DISABLED';
    if (sessionExpired) return 'SESSION_EXPIRED';
    if (stopped) return 'STOPPED';
    if (storageBlocked) return 'STORAGE_BLOCKED';
    return null;
  }

  function stop(expired = false) {
    stopped = true;
    sessionExpired ||= expired;
    token = undefined;
    capabilities = new WeakMap();
    if (!durable) {
      cursor = '';
      for (const record of ledger.values()) record.contextToken = undefined;
    }
    for (const controller of active) controller.abort();
  }

  function serial(work) {
    const operation = operations.then(work);
    operations = operation.catch(() => {});
    return operation;
  }

  function blockStorage() {
    storageBlocked = true;
    token = undefined;
    capabilities = new WeakMap();
    for (const record of ledger.values()) {
      record.contextToken = undefined;
      record.text = undefined;
      record.inbound = undefined;
    }
    for (const controller of active) controller.abort();
  }

  function wallTime() {
    const value = wallNow();
    if (!Number.isSafeInteger(value) || value < 0 || value < lastObservedAtMs) throw new Error('INVALID_CLOCK');
    lastObservedAtMs = value;
    return value;
  }

  function snapshot(records, nextCursor, observedAtMs) {
    return {
      schemaVersion: 1,
      botId,
      ownerUserId,
      cursor: nextCursor,
      lastObservedAtMs: observedAtMs,
      entries: [...records].map(([id, record]) => ({
        id,
        clientId: record.clientId,
        createdAtMs: record.createdAtMs,
        outcome: record.outcome,
        ...(record.outcome === null ? { text: record.text, contextToken: record.contextToken } : {})
      }))
    };
  }

  async function persist(records = ledger, nextCursor = cursor) {
    try {
      const observedAtMs = wallTime();
      await stateStore.save(snapshot(records, nextCursor, observedAtMs));
      lastObservedAtMs = observedAtMs;
      return true;
    } catch {
      blockStorage();
      return false;
    }
  }

  function exactFields(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(fields).length === keys.length && keys.every(key => Object.hasOwn(fields, key) && Object.hasOwn(fields[key], 'value'));
  }

  function attachInbound(id, record) {
    const inbound = privateInbound({ botId, peerId: ownerUserId, messageId: id, contextToken: record.contextToken, text: record.text });
    capabilities.set(inbound, record);
    record.inbound = inbound;
    return inbound;
  }

  async function initializeInternal() {
    if (state()) return diagnostic(state());
    if (initialized) return diagnostic('OK', { restoredCount: 0 });
    try {
      const loaded = await stateStore.load();
      if (state()) return diagnostic(state());
      const current = wallTime();
      const restored = new Map();
      let restoredCursor = '';
      if (loaded !== null && loaded !== undefined) {
        if (!exactFields(loaded, ['schemaVersion', 'botId', 'ownerUserId', 'cursor', 'lastObservedAtMs', 'entries']) || loaded.schemaVersion !== 1 || loaded.botId !== botId || loaded.ownerUserId !== ownerUserId || typeof loaded.cursor !== 'string' || loaded.cursor.length > 16384 || !Number.isSafeInteger(loaded.lastObservedAtMs) || loaded.lastObservedAtMs < 0 || loaded.lastObservedAtMs > current || !Array.isArray(loaded.entries) || loaded.entries.length > MAX_SESSION_MESSAGES) throw new Error('INVALID_STATE');
        restoredCursor = loaded.cursor;
        lastObservedAtMs = Math.max(lastObservedAtMs, loaded.lastObservedAtMs);
        const clientIds = new Set();
        for (const entry of loaded.entries) {
          const pending = entry?.outcome === null;
          if (!exactFields(entry, ['id', 'clientId', 'createdAtMs', 'outcome', ...(pending ? ['text', 'contextToken'] : [])]) || typeof entry.id !== 'string' || messageId(entry.id) !== entry.id || restored.has(entry.id) || !/^dots-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.clientId) || clientIds.has(entry.clientId) || !Number.isSafeInteger(entry.createdAtMs) || entry.createdAtMs < 0 || entry.createdAtMs > loaded.lastObservedAtMs || (!pending && !OUTCOMES.has(entry.outcome)) || (pending && (!validText(entry.text, 4000, 16000) || !opaque(entry.contextToken)))) throw new Error('INVALID_STATE');
          clientIds.add(entry.clientId);
          const record = { ...entry };
          delete record.id;
          if (record.outcome === 'IN_FLIGHT') {
            record.outcome = 'OUTCOME_UNKNOWN';
          } else if (pending && current - record.createdAtMs >= contextTtlMs) {
            record.outcome = 'EXPIRED_CONTEXT';
            delete record.text;
            delete record.contextToken;
          }
          restored.set(entry.id, record);
        }
      }
      if (!(await persist(restored, restoredCursor))) return diagnostic('STORAGE_BLOCKED');
      if (state()) return diagnostic(state());
      ledger = restored;
      cursor = restoredCursor;
      lastObservedAtMs = Math.max(lastObservedAtMs, current);
      initialized = true;
      let restoredCount = 0;
      for (const [id, record] of ledger) {
        if (record.outcome === null) {
          attachInbound(id, record);
          restoredCount++;
        }
      }
      return diagnostic('OK', { restoredCount });
    } catch {
      blockStorage();
      return diagnostic('STORAGE_BLOCKED');
    }
  }

  function initialize() {
    return durable ? serial(initializeInternal) : Promise.resolve(diagnostic(state() || 'OK', { restoredCount: 0 }));
  }

  async function prunePending() {
    let current;
    try {
      current = wallTime();
    } catch {
      blockStorage();
      return false;
    }
    let changed = false;
    const staged = new Map(ledger);
    for (const [id, record] of ledger) {
      if (record.outcome === null && current - record.createdAtMs >= contextTtlMs) {
        staged.set(id, { ...record, outcome: 'EXPIRED_CONTEXT', text: undefined, contextToken: undefined, inbound: undefined });
        changed = true;
      }
    }
    if (changed) {
      if (!(await persist(staged))) return false;
      for (const [id, record] of ledger) {
        const next = staged.get(id);
        if (next !== record) Object.assign(record, next);
      }
    }
    return true;
  }

  async function pendingInternal() {
    const ready = await initializeInternal();
    if (ready.status !== 'OK') return pollResult(ready.status);
    if (durable && !(await prunePending())) return pollResult('STORAGE_BLOCKED');
    if (state()) return pollResult(state());
    return pollResult('OK', [...ledger.values()].filter(record => record.outcome === null).map(record => record.inbound));
  }

  function pendingMessages() {
    return durable ? serial(pendingInternal) : pendingInternal();
  }

  async function request(path, body, duration) {
    const blocked = state();
    if (blocked) return { error: blocked, attempted: false };
    const controller = new AbortController();
    active.add(controller);
    let timedOut = false;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('REQUEST_TIMEOUT'));
      }, duration);
    });
    const url = `${ORIGIN}${path}`;
    const work = async () => {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${token}`,
          'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': VERSION_NUMBER
        },
        body: JSON.stringify({ ...body, base_info: { channel_version: VERSION, bot_agent: 'DotsWatch/0.1.0' } })
      });
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) return { error: 'REDIRECT_REJECTED', attempted: true };
      const parsed = parseWeixinJson(await readBounded(response));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'PROTOCOL_ERROR', attempted: true };
      if (parsed.ret === -14 || parsed.errcode === -14) {
        stop(true);
        return { error: 'SESSION_EXPIRED', attempted: true };
      }
      if (response.status !== 200) return { error: 'HTTP_ERROR', attempted: true };
      if (state()) return { error: state(), attempted: true };
      return { body: parsed, attempted: true };
    };
    try {
      return await Promise.race([work(), deadline]);
    } catch {
      return { error: timedOut ? 'TIMEOUT' : state() || 'TRANSPORT_ERROR', attempted: true };
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      controller.abort();
    }
  }

  async function getUpdatesInternal() {
    const blocked = state();
    if (blocked) return pollResult(blocked);
    if (polling) return pollResult('BUSY');
    if (durable && !(await prunePending())) return pollResult('STORAGE_BLOCKED');
    if (state()) return pollResult(state());
    if (ledger.size >= MAX_SESSION_MESSAGES) return pollResult('SESSION_LIMIT');
    polling = true;
    try {
      const response = await request('/ilink/bot/getupdates', { get_updates_buf: cursor }, pollTimeoutMs);
      if (response.error) return pollResult(response.error);
      const body = response.body;
      for (const key of ['ret', 'errcode']) {
        if (body[key] !== undefined && !Number.isSafeInteger(body[key])) return pollResult('PROTOCOL_ERROR');
      }
      if ((body.ret !== undefined && body.ret !== 0) || (body.errcode !== undefined && body.errcode !== 0)) return pollResult('REJECTED');
      const batch = body.msgs === undefined ? [] : body.msgs;
      const hasSuccessShape = body.ret === 0 || body.errcode === 0 || Array.isArray(body.msgs) || typeof body.get_updates_buf === 'string';
      if (!hasSuccessShape || !Array.isArray(batch) || batch.length > MAX_MESSAGES || (body.get_updates_buf !== undefined && (typeof body.get_updates_buf !== 'string' || body.get_updates_buf.length > 16384))) return pollResult('PROTOCOL_ERROR');
      if (durable && !(await prunePending())) return pollResult('STORAGE_BLOCKED');
      if (state()) return pollResult(state());
      const messages = [];
      const staged = new Map(ledger);
      let receivedAtMs;
      if (durable) {
        try { receivedAtMs = wallTime(); } catch { blockStorage(); return pollResult('STORAGE_BLOCKED'); }
      }
      let rejectedCount = 0;
      for (const message of batch) {
        const id = messageId(message?.message_id);
        const text = message?.item_list?.[0]?.text_item?.text;
        if (!message || message.from_user_id !== ownerUserId || (message.to_user_id !== undefined && message.to_user_id !== '' && message.to_user_id !== botId) || (message.group_id !== undefined && message.group_id !== '') || message.message_type !== 1 || message.message_state !== 2 || (message.delete_time_ms !== undefined && message.delete_time_ms !== 0) || !Array.isArray(message.item_list) || message.item_list.length !== 1 || message.item_list[0]?.type !== 1 || !validText(text, 4000, 16000) || !id || !opaque(message.context_token) || staged.has(id)) {
          rejectedCount++;
          continue;
        }
        if (staged.size >= MAX_SESSION_MESSAGES) return pollResult('SESSION_LIMIT');
        const record = { contextToken: message.context_token, text, createdAt: now(), createdAtMs: receivedAtMs, clientId: `dots-${randomUUID()}`, outcome: null };
        staged.set(id, record);
        messages.push([id, record]);
      }
      const nextCursor = body.get_updates_buf || cursor;
      if (durable) {
        if (!(await persist(staged, nextCursor))) return pollResult('STORAGE_BLOCKED');
        if (state()) return pollResult(state());
      }
      ledger = staged;
      for (let index = 0; index < messages.length; index++) messages[index] = attachInbound(...messages[index]);
      cursor = nextCursor;
      return pollResult('OK', messages, rejectedCount);
    } finally {
      polling = false;
    }
  }

  async function sendTextInternal(args = {}) {
    const blocked = state();
    if (blocked) return diagnostic(blocked, { attempted: false });
    if (!args || typeof args !== 'object' || Array.isArray(args)) return diagnostic('INVALID_ARGUMENTS', { attempted: false });
    const fields = Object.getOwnPropertyDescriptors(args);
    if (Reflect.ownKeys(fields).some(key => key !== 'inbound' && key !== 'text') || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) return diagnostic('INVALID_ARGUMENTS', { attempted: false });
    const record = capabilities.get(fields.inbound?.value);
    if (!record) return diagnostic('INVALID_INBOUND', { attempted: false });
    const text = fields.text?.value;
    if (!validText(text, 800, 2048)) return diagnostic('INVALID_TEXT', { attempted: false });
    if (record.outcome) return diagnostic('ALREADY_ATTEMPTED', { attempted: false, outcome: record.outcome });
    let age;
    try { age = durable ? wallTime() - record.createdAtMs : now() - record.createdAt; } catch { blockStorage(); return diagnostic('STORAGE_BLOCKED', { attempted: false }); }
    if (!Number.isFinite(age) || age < 0 || age >= contextTtlMs) {
      record.contextToken = undefined;
      record.outcome = 'EXPIRED_CONTEXT';
      record.text = undefined;
      if (durable && !(await persist())) return diagnostic('STORAGE_BLOCKED', { attempted: false });
      return diagnostic('EXPIRED_CONTEXT', { attempted: false });
    }
    const contextToken = record.contextToken;
    record.contextToken = undefined;
    record.outcome = 'IN_FLIGHT';
    record.text = undefined;
    if (durable && !(await persist())) return diagnostic('STORAGE_BLOCKED', { attempted: false });
    if (state()) return diagnostic(state(), { attempted: false });
    if (durable) {
      try { age = wallTime() - record.createdAtMs; } catch { blockStorage(); return diagnostic('STORAGE_BLOCKED', { attempted: false }); }
      if (age >= contextTtlMs) {
        record.outcome = 'EXPIRED_CONTEXT';
        if (!(await persist())) return diagnostic('STORAGE_BLOCKED', { attempted: false });
        return diagnostic('EXPIRED_CONTEXT', { attempted: false });
      }
    }
    const response = await request('/ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: ownerUserId,
        client_id: record.clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }]
      }
    }, timeoutMs);
    let status;
    if (response.error === 'SESSION_EXPIRED') status = 'SESSION_EXPIRED';
    else if (response.error) status = 'OUTCOME_UNKNOWN';
    else {
      const { ret, errcode } = response.body;
      if ((Number.isInteger(ret) && ret !== 0) || (Number.isInteger(errcode) && errcode !== 0)) status = 'REJECTED';
      else if (ret === 0 && (errcode === undefined || errcode === 0)) status = 'API_ACCEPTED';
      else if (ret === undefined && errcode === undefined) {
        const serverMessageId = messageId(response.body.message_id);
        status = serverMessageId !== null && serverMessageId !== '0' ? 'API_ACCEPTED' : 'OUTCOME_UNKNOWN';
      } else status = 'OUTCOME_UNKNOWN';
    }
    record.outcome = status;
    if (durable && !(await persist())) {
      record.outcome = 'OUTCOME_UNKNOWN';
      return diagnostic('OUTCOME_UNKNOWN', { attempted: response.attempted, deliveryConfirmed: false, storageStatus: 'STORAGE_BLOCKED' });
    }
    return diagnostic(status, { attempted: response.attempted, deliveryConfirmed: false });
  }

  function getUpdates() {
    if (!durable) return getUpdatesInternal();
    return serial(async () => {
      const ready = await initializeInternal();
      return ready.status === 'OK' ? getUpdatesInternal() : pollResult(ready.status);
    });
  }

  function sendText(args) {
    if (!durable) return sendTextInternal(args);
    return serial(async () => {
      const ready = await initializeInternal();
      return ready.status === 'OK' ? sendTextInternal(args) : diagnostic(ready.status, { attempted: false });
    });
  }

  function close() {
    stop();
    if (!durable) return;
    if (!closePromise) closePromise = serial(async () => {
      cursor = '';
      ledger.clear();
      await stateStore.close();
    });
    return closePromise;
  }

  return Object.freeze({ initialize, pendingMessages, getUpdates, sendText, close });
}

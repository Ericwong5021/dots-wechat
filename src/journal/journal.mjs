import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const FORMAT = 'dots-wechat-journal/1';
const PAYLOAD_TTL = 600000;
const DEDUPE_TTL = 86400000;
const GRANT_TTL = 3600000;
const MAX_FILE_BYTES = 8388608;
const PRINCIPAL_FIELDS = ['tenantId', 'subject', 'grantId', 'bindingId', 'watchId', 'generation', 'revision'];
const MESSAGE_FIELDS = ['requestId', 'messageId', 'eventId', 'subscriptionId'];
const OUTCOMES = ['READY', 'OUTCOME_UNKNOWN', 'ACCEPTED', 'REJECTED', 'CANCELLED'];
const DOWNLINKS = ['AWAITING_REPLY', 'QUEUED', 'OUTCOME_UNKNOWN', 'RECEIPT_RECORDED', 'CANCELLED'];
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const clone = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length >= 1 && value.length <= 512 && !/[\u0000-\u0020\u007f]/.test(value);
const digestValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const demand = (condition, code) => { if (!condition) throw new JournalError(code); };
const validPrincipal = value => exact(value, PRINCIPAL_FIELDS) && PRINCIPAL_FIELDS.every(field => ['generation', 'revision'].includes(field) ? integer(value[field]) && value[field] >= 1 && value[field] < Number.MAX_SAFE_INTEGER : identifier(value[field]));
const validText = (text, units, bytes) => typeof text === 'string' && text.trim().length > 0 && text.length <= units && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) && Buffer.byteLength(text, 'utf8') <= bytes && Buffer.from(text, 'utf8').toString('utf8') === text;
const safeMode = stat => (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());

export class JournalError extends Error {
  constructor(code, outcome = 'NOT_STARTED') {
    super(code);
    this.name = 'JournalError';
    this.code = code;
    this.outcome = outcome;
    this.retryAutomatically = false;
  }
}

export function createJournal() {
  const disabled = async () => { throw new JournalError('JOURNAL_NOT_CONFIGURED'); };
  return Object.freeze({ status: () => ({ configured: false, liveEnabled: false, personalDot: 'not_connected' }), open: disabled });
}

export async function openJournal({ directory, key, mode, clock = Date.now, failureInjector = null } = {}) {
  demand(typeof directory === 'string' && path.isAbsolute(directory), 'EXPLICIT_DIRECTORY_REQUIRED');
  demand(Buffer.isBuffer(key) && key.length === 32, 'EXPLICIT_256_BIT_KEY_REQUIRED');
  demand(['create', 'open', 'recover'].includes(mode), 'EXPLICIT_OPEN_MODE_REQUIRED');
  demand(typeof clock === 'function' && (failureInjector === null || typeof failureInjector === 'function'), 'INVALID_DEPENDENCY');
  const secret = Buffer.from(key);
  const keyedHash = (domain, value) => createHmac('sha256', secret).update(`${FORMAT}:${domain}:`).update(canonical(value)).digest('hex');
  const watchKey = principal => keyedHash('watch', principal.watchId);
  const grantKey = principal => keyedHash('grant', principal.grantId);
  const requestKey = args => keyedHash('request', [args.tenantId, args.subject, args.requestId]);
  const tick = () => { const value = clock(); demand(integer(value) && value <= Number.MAX_SAFE_INTEGER - DEDUPE_TTL, 'INVALID_CLOCK'); return value; };
  let root, directoryIdentity, lock, lockIdentity, snapshotIdentity, state, closed = false, accepting = true, poisoned = false, tail = Promise.resolve();
  const fileName = 'journal.aead';
  const lockName = 'journal.lock';
  const snapshot = () => path.join(root, fileName);
  const assertDirectory = async () => {
    const current = await fs.lstat(root);
    demand(current.isDirectory() && !current.isSymbolicLink() && safeMode(current) && current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino, 'DIRECTORY_CHANGED');
  };
  const assertLock = async () => {
    await assertDirectory();
    const current = await fs.lstat(path.join(root, lockName));
    demand(current.isFile() && current.nlink === 1 && safeMode(current) && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino, 'LOCK_OWNERSHIP_LOST');
  };
  const syncDirectory = async () => {
    const handle = await fs.open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const releaseLock = async () => {
    if (!lock) return;
    try { await assertLock(); await fs.unlink(path.join(root, lockName)); await syncDirectory(); }
    finally { await lock.close(); lock = null; }
  };
  const stage = async name => { if (failureInjector) await failureInjector(name); };
  const encrypt = next => {
    const plaintext = Buffer.from(JSON.stringify(next), 'utf8');
    demand(plaintext.length <= MAX_FILE_BYTES / 2, 'JOURNAL_CAPACITY_REACHED');
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, nonce);
      cipher.setAAD(Buffer.from(`${FORMAT}\n${root}`));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.from(JSON.stringify({ format: FORMAT, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    } finally { plaintext.fill(0); }
  };
  const persist = async next => {
    const encrypted = encrypt(next);
    const temporary = path.join(root, `.pending-${randomUUID()}`);
    let handle;
    try {
      await assertLock();
      if (snapshotIdentity) {
        const current = await fs.lstat(snapshot());
        demand(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && safeMode(current) && current.ino === snapshotIdentity.ino && current.dev === snapshotIdentity.dev, 'SNAPSHOT_CHANGED');
      }
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await stage('after_temp_open');
      await handle.writeFile(encrypted);
      await stage('after_temp_write');
      await handle.sync();
      await stage('after_file_sync');
      await handle.close(); handle = null;
      await stage('before_rename');
      await fs.rename(temporary, snapshot());
      await stage('after_rename');
      await syncDirectory();
      await stage('after_directory_sync');
      snapshotIdentity = await fs.lstat(snapshot());
      state = next;
    } catch {
      poisoned = true;
      throw new JournalError('WRITE_OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN');
    } finally {
      encrypted.fill(0);
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  };
  const validateState = value => {
    demand(exact(value, ['version', 'commitRevision', 'lastNow', 'watches', 'usedGrants', 'records']) && value.version === 1 && integer(value.commitRevision) && integer(value.lastNow), 'INVALID_SNAPSHOT');
    demand(plain(value.watches) && plain(value.usedGrants) && plain(value.records) && Object.keys(value.watches).length <= 1024 && Object.keys(value.usedGrants).length <= 4096 && Object.keys(value.records).length <= 256, 'INVALID_SNAPSHOT');
    for (const [index, slot] of Object.entries(value.watches)) {
      demand(digestValid(index) && exact(slot, ['active', 'generationFloor', 'revisionFloor', 'principal', 'expiresAt']) && typeof slot.active === 'boolean' && integer(slot.generationFloor) && slot.generationFloor >= 1 && integer(slot.revisionFloor) && slot.revisionFloor >= 1 && integer(slot.expiresAt), 'INVALID_SNAPSHOT');
      demand(slot.active ? validPrincipal(slot.principal) && watchKey(slot.principal) === index && slot.principal.generation === slot.generationFloor && slot.principal.revision === slot.revisionFloor : slot.principal === null && slot.expiresAt === 0, 'INVALID_SNAPSHOT');
    }
    for (const [index, watch] of Object.entries(value.usedGrants)) demand(digestValid(index) && digestValid(watch) && Object.hasOwn(value.watches, watch), 'INVALID_SNAPSHOT');
    for (const [index, record] of Object.entries(value.records)) {
      demand(digestValid(index) && validPrincipal(record.principal) && MESSAGE_FIELDS.every(field => identifier(record[field])) && index === requestKey({ ...record.principal, requestId: record.requestId }) && record.watchKey === watchKey(record.principal), 'INVALID_SNAPSHOT');
      demand(digestValid(record.digest) && integer(record.createdAt) && integer(record.payloadExpiresAt) && record.payloadExpiresAt === record.createdAt + PAYLOAD_TTL && integer(record.tombstoneUntil) && typeof record.cancelled === 'boolean' && OUTCOMES.includes(record.uplink) && DOWNLINKS.includes(record.downlink), 'INVALID_SNAPSHOT');
      demand(record.text === null || validText(record.text, 4000, 16000), 'INVALID_SNAPSHOT');
      demand(record.dispatchAttemptId === null || identifier(record.dispatchAttemptId), 'INVALID_SNAPSHOT');
      demand(record.deliveryAttemptId === null || identifier(record.deliveryAttemptId), 'INVALID_SNAPSHOT');
      demand(record.reply === null || (exact(record.reply, ['replyId', 'digest', 'text']) && identifier(record.reply.replyId) && digestValid(record.reply.digest) && (record.reply.text === null || validText(record.reply.text, 800, 2048))), 'INVALID_SNAPSHOT');
    }
    return value;
  };
  const load = async () => {
    let handle;
    try {
      handle = await fs.open(snapshot(), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      demand(stat.isFile() && stat.nlink === 1 && safeMode(stat) && stat.size > 0 && stat.size <= MAX_FILE_BYTES, 'INVALID_SNAPSHOT_FILE');
      snapshotIdentity = stat;
      const bytes = await handle.readFile();
      demand(bytes.length <= MAX_FILE_BYTES, 'INVALID_SNAPSHOT_FILE');
      const envelope = JSON.parse(bytes.toString('utf8'));
      demand(exact(envelope, ['format', 'nonce', 'tag', 'ciphertext']) && envelope.format === FORMAT, 'INVALID_SNAPSHOT');
      for (const field of ['nonce', 'tag', 'ciphertext']) demand(typeof envelope[field] === 'string' && Buffer.from(envelope[field], 'base64').toString('base64') === envelope[field], 'INVALID_SNAPSHOT');
      const nonce = Buffer.from(envelope.nonce, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      demand(nonce.length === 12 && tag.length === 16, 'INVALID_SNAPSHOT');
      const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
      decipher.setAAD(Buffer.from(`${FORMAT}\n${root}`)); decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      try { return validateState(JSON.parse(plaintext.toString('utf8'))); }
      finally { plaintext.fill(0); }
    } catch { throw new JournalError('SNAPSHOT_UNAVAILABLE_OR_INVALID'); }
    finally { if (handle) await handle.close(); }
  };
  const erasePayload = record => { record.text = null; if (record.reply) record.reply.text = null; };
  const cancelRecord = (record, now) => {
    if (!record.cancelled) record.tombstoneUntil = Math.max(record.tombstoneUntil, now + DEDUPE_TTL);
    record.cancelled = true;
    if (record.uplink === 'READY') record.uplink = 'CANCELLED';
    if (['AWAITING_REPLY', 'QUEUED'].includes(record.downlink)) record.downlink = 'CANCELLED';
    erasePayload(record);
  };
  const retire = (draft, index, now) => {
    const slot = draft.watches[index];
    if (slot.active) {
      slot.generationFloor = slot.principal.generation + 1;
      slot.revisionFloor = slot.principal.revision + 1;
      slot.active = false; slot.principal = null; slot.expiresAt = 0;
      for (const record of Object.values(draft.records)) if (record.watchKey === index) cancelRecord(record, now);
    }
  };
  const maintenance = (draft, now) => {
    for (const [index, slot] of Object.entries(draft.watches)) if (slot.active && slot.expiresAt <= now) retire(draft, index, slot.expiresAt);
    for (const [index, record] of Object.entries(draft.records)) {
      if (record.payloadExpiresAt <= now) {
        erasePayload(record);
        if (record.uplink === 'READY') record.uplink = 'CANCELLED';
        if (record.downlink === 'QUEUED') record.downlink = 'CANCELLED';
      }
      if (record.tombstoneUntil <= now) delete draft.records[index];
    }
    draft.lastNow = now;
  };
  const current = (draft, principal) => {
    demand(validPrincipal(principal), 'INVALID_PRINCIPAL');
    const slot = draft.watches[watchKey(principal)];
    demand(slot?.active && canonical(slot.principal) === canonical(principal), 'STALE_OR_REVOKED_AUTHORIZATION');
    return slot;
  };
  const findRecord = (draft, principal, requestId, requireActive = true) => {
    if (requireActive) current(draft, principal);
    const record = draft.records[requestKey({ ...principal, requestId })];
    demand(record && canonical(record.principal) === canonical(principal), 'REQUEST_NOT_FOUND');
    return record;
  };
  const view = record => ({ requestId: record.requestId, messageId: record.messageId, eventId: record.eventId, subscriptionId: record.subscriptionId, generation: record.principal.generation, authorizationRevision: record.principal.revision, uplink: record.uplink, downlink: record.downlink, cancelled: record.cancelled, dispatchAttemptId: record.dispatchAttemptId, deliveryAttemptId: record.deliveryAttemptId, replyId: record.reply?.replyId ?? null, payloadPresent: record.text !== null || record.reply?.text != null, payloadExpiresAt: record.payloadExpiresAt, tombstoneUntil: record.tombstoneUntil, retryAutomatically: false, personalDot: 'not_connected' });
  const transaction = (input, mutate, writes = true) => {
    if (!accepting) return Promise.reject(new JournalError('JOURNAL_CLOSED'));
    let args;
    try { args = clone(input); } catch { return Promise.reject(new JournalError('INVALID_ARGUMENTS')); }
    const task = tail.then(async () => {
      demand(!poisoned && !closed, poisoned ? 'JOURNAL_POISONED' : 'JOURNAL_CLOSED');
      let now;
      try { now = tick(); demand(now >= state.lastNow, 'CLOCK_MOVED_BACKWARDS'); await assertLock(); }
      catch (error) { poisoned = true; throw new JournalError(error instanceof JournalError ? error.code : 'STORAGE_UNAVAILABLE'); }
      const cleaned = clone(state); maintenance(cleaned, now);
      const draft = clone(cleaned);
      let result, failure;
      try {
        demand(plain(args), 'INVALID_ARGUMENTS');
        if (writes) demand(integer(args.expectedRevision) && args.expectedRevision === state.commitRevision, 'COMMIT_REVISION_CONFLICT');
        result = mutate(draft, args, now);
      } catch (error) { failure = error instanceof JournalError ? error : new JournalError('INVALID_ARGUMENTS'); }
      const next = failure ? cleaned : draft;
      if (canonical(next) !== canonical(state)) {
        demand(state.commitRevision < Number.MAX_SAFE_INTEGER, 'REVISION_EXHAUSTED');
        next.commitRevision = state.commitRevision + 1;
        await persist(next);
      }
      if (failure) throw failure;
      return clone({ commitRevision: state.commitRevision, ...result });
    });
    tail = task.catch(() => {});
    return task;
  };
  try {
    if (mode === 'create') await fs.mkdir(directory, { mode: 0o700 });
    const requested = await fs.lstat(directory);
    demand(requested.isDirectory() && !requested.isSymbolicLink() && safeMode(requested), 'PRIVATE_DIRECTORY_REQUIRED');
    root = await fs.realpath(directory); directoryIdentity = await fs.lstat(root);
    try { lock = await fs.open(path.join(root, lockName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new JournalError('JOURNAL_LOCKED_OR_UNAVAILABLE'); }
    lockIdentity = await lock.stat();
    await lock.writeFile(randomUUID()); await lock.sync(); await syncDirectory();
    if (mode === 'create') {
      state = { version: 1, commitRevision: 0, lastNow: tick(), watches: {}, usedGrants: {}, records: {} };
      await persist(state);
    } else {
      state = await load();
      const now = tick(); demand(now >= state.lastNow, 'CLOCK_MOVED_BACKWARDS');
      const entries = await fs.readdir(root);
      for (const entry of entries) {
        if ([fileName, lockName].includes(entry)) continue;
        demand(/^\.pending-[a-f0-9-]{36}$/.test(entry), 'UNEXPECTED_DIRECTORY_ENTRY');
        const pending = await fs.lstat(path.join(root, entry));
        demand(pending.isFile() && !pending.isSymbolicLink() && pending.nlink === 1 && safeMode(pending), 'UNSAFE_PENDING_FILE');
        await fs.unlink(path.join(root, entry));
      }
      await syncDirectory();
      const next = clone(state);
      if (mode === 'recover') for (const index of Object.keys(next.watches)) retire(next, index, now);
      maintenance(next, now);
      if (canonical(next) !== canonical(state)) {
        demand(next.commitRevision < Number.MAX_SAFE_INTEGER, 'REVISION_EXHAUSTED');
        next.commitRevision += 1; await persist(next);
      }
    }
  } catch (error) {
    if (lock) {
      if (poisoned || mode === 'recover') { await lock.close().catch(() => {}); lock = null; }
      else await releaseLock().catch(() => {});
    }
    secret.fill(0);
    throw error instanceof JournalError ? error : new JournalError('JOURNAL_OPEN_FAILED');
  }
  return Object.freeze({
    status: () => ({ configured: true, liveEnabled: false, personalDot: 'not_connected', poisoned, closed: !accepting }),
    inspect: () => transaction({}, draft => ({ records: Object.keys(draft.records).length, permanentWatchFloors: Object.keys(draft.watches).length, permanentGrantDigests: Object.keys(draft.usedGrants).length }), false),
    readStatus: args => transaction(args, (draft, input) => {
      demand(exact(input, ['tenantId', 'subject', 'requestId']) && Object.values(input).every(identifier), 'INVALID_ARGUMENTS');
      const record = draft.records[requestKey(input)]; demand(record, 'REQUEST_NOT_FOUND');
      return view(record);
    }, false),
    inspectBinding: args => transaction(args, (draft, input) => {
      demand(exact(input, ['watchId']) && identifier(input.watchId), 'INVALID_ARGUMENTS');
      const slot = draft.watches[watchKey(input)]; demand(slot, 'BINDING_NOT_FOUND');
      return { active: slot.active, generationFloor: slot.generationFloor, revisionFloor: slot.revisionFloor };
    }, false),
    sweep: () => transaction({}, () => ({ swept: true }), false),
    bind: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', 'expiresAt', 'expectedRevision']) && validPrincipal(input.principal) && integer(input.expiresAt) && input.expiresAt > now && input.expiresAt <= now + GRANT_TTL, 'INVALID_BINDING');
      const index = watchKey(input.principal), grant = grantKey(input.principal), prior = draft.watches[index];
      if (prior?.active && canonical(prior.principal) === canonical(input.principal) && prior.expiresAt === input.expiresAt) return { bound: true };
      demand(!Object.hasOwn(draft.usedGrants, grant), 'GRANT_ALREADY_USED');
      if (prior) demand(input.principal.generation >= prior.generationFloor + (prior.active ? 1 : 0) && input.principal.revision >= prior.revisionFloor + (prior.active ? 1 : 0), 'STALE_BINDING_REVISION');
      demand((prior || Object.keys(draft.watches).length < 1024) && Object.keys(draft.usedGrants).length < 4096, 'JOURNAL_CAPACITY_REACHED');
      if (prior?.active) retire(draft, index, now);
      draft.watches[index] = { active: true, generationFloor: input.principal.generation, revisionFloor: input.principal.revision, principal: clone(input.principal), expiresAt: input.expiresAt };
      draft.usedGrants[grant] = index;
      return { bound: true };
    }),
    revoke: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', 'expectedRevision']), 'INVALID_ARGUMENTS'); current(draft, input.principal);
      retire(draft, watchKey(input.principal), now);
      return { revokedLocally: true, remoteRevocation: 'not_attempted' };
    }),
    enqueue: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', ...MESSAGE_FIELDS, 'text', 'expectedRevision']) && MESSAGE_FIELDS.every(field => identifier(input[field])) && validText(input.text, 4000, 16000), 'INVALID_MESSAGE');
      current(draft, input.principal);
      const material = { ...input }; delete material.expectedRevision;
      const digest = keyedHash('message', material), index = requestKey({ ...input.principal, requestId: input.requestId }), prior = draft.records[index];
      if (prior) { demand(prior.digest === digest, 'REQUEST_CONFLICT'); return view(prior); }
      demand(Object.keys(draft.records).length < 256, 'JOURNAL_CAPACITY_REACHED');
      demand(!Object.values(draft.records).some(record => record.principal.tenantId === input.principal.tenantId && record.principal.subject === input.principal.subject && record.messageId === input.messageId), 'MESSAGE_ALREADY_USED');
      demand(!Object.values(draft.records).some(record => record.eventId === input.eventId), 'EVENT_ALREADY_USED');
      const record = { principal: clone(input.principal), ...Object.fromEntries(MESSAGE_FIELDS.map(field => [field, input[field]])), watchKey: watchKey(input.principal), digest, createdAt: now, payloadExpiresAt: now + PAYLOAD_TTL, tombstoneUntil: now + DEDUPE_TTL, text: input.text, reply: null, uplink: 'READY', downlink: 'AWAITING_REPLY', cancelled: false, dispatchAttemptId: null, deliveryAttemptId: null };
      draft.records[index] = record;
      return view(record);
    }),
    claimDispatch: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', 'requestId', 'expectedRevision']) && identifier(input.requestId), 'INVALID_ARGUMENTS');
      const record = findRecord(draft, input.principal, input.requestId);
      demand(!record.cancelled && record.text !== null && record.uplink === 'READY' && record.dispatchAttemptId === null, 'DISPATCH_NOT_AVAILABLE');
      record.dispatchAttemptId = randomUUID(); record.uplink = 'OUTCOME_UNKNOWN'; record.tombstoneUntil = now + DEDUPE_TTL;
      return { ...view(record), text: record.text };
    }),
    recordDispatch: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', 'requestId', 'attemptId', 'outcome', 'expectedRevision']) && identifier(input.requestId) && identifier(input.attemptId) && ['ACCEPTED', 'REJECTED', 'OUTCOME_UNKNOWN'].includes(input.outcome), 'INVALID_ARGUMENTS');
      const record = findRecord(draft, input.principal, input.requestId);
      demand(!record.cancelled && record.dispatchAttemptId === input.attemptId, 'STALE_DISPATCH_RESULT');
      if (record.uplink === input.outcome) return view(record);
      demand(record.uplink === 'OUTCOME_UNKNOWN', 'STALE_DISPATCH_RESULT');
      record.uplink = input.outcome; record.tombstoneUntil = now + DEDUPE_TTL;
      if (input.outcome === 'REJECTED') {
        if (['AWAITING_REPLY', 'QUEUED'].includes(record.downlink)) record.downlink = 'CANCELLED';
        erasePayload(record);
      }
      return view(record);
    }),
    queueReply: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', ...MESSAGE_FIELDS, 'replyId', 'text', 'expectedRevision']) && MESSAGE_FIELDS.every(field => identifier(input[field])) && identifier(input.replyId) && validText(input.text, 800, 2048), 'INVALID_REPLY');
      const record = findRecord(draft, input.principal, input.requestId);
      demand(MESSAGE_FIELDS.every(field => input[field] === record[field]), 'CORRELATION_MISMATCH');
      demand(!record.cancelled && record.payloadExpiresAt > now && ['ACCEPTED', 'OUTCOME_UNKNOWN'].includes(record.uplink), 'REPLY_NOT_AVAILABLE');
      const digest = keyedHash('reply', { requestId: input.requestId, replyId: input.replyId, text: input.text });
      if (record.reply) { demand(record.reply.digest === digest, 'REPLY_CONFLICT'); return view(record); }
      demand(!Object.values(draft.records).some(other => other.principal.tenantId === input.principal.tenantId && other.principal.subject === input.principal.subject && other.reply?.replyId === input.replyId), 'REPLY_ALREADY_USED');
      record.reply = { replyId: input.replyId, text: input.text, digest }; record.downlink = 'QUEUED'; record.tombstoneUntil = now + DEDUPE_TTL;
      return view(record);
    }),
    claimReply: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', 'requestId', 'expectedRevision']) && identifier(input.requestId), 'INVALID_ARGUMENTS');
      const record = findRecord(draft, input.principal, input.requestId);
      demand(!record.cancelled && record.reply?.text != null && record.downlink === 'QUEUED' && record.deliveryAttemptId === null, 'REPLY_NOT_AVAILABLE');
      record.deliveryAttemptId = randomUUID(); record.downlink = 'OUTCOME_UNKNOWN'; record.tombstoneUntil = now + DEDUPE_TTL;
      return { ...view(record), text: record.reply.text };
    }),
    recordReceipt: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', 'requestId', 'replyId', 'attemptId', 'expectedRevision']) && ['requestId', 'replyId', 'attemptId'].every(field => identifier(input[field])), 'INVALID_ARGUMENTS');
      const record = findRecord(draft, input.principal, input.requestId);
      demand(!record.cancelled && record.reply?.replyId === input.replyId && record.deliveryAttemptId === input.attemptId && ['OUTCOME_UNKNOWN', 'RECEIPT_RECORDED'].includes(record.downlink), 'CORRELATION_MISMATCH');
      if (record.downlink !== 'RECEIPT_RECORDED') record.tombstoneUntil = now + DEDUPE_TTL;
      record.downlink = 'RECEIPT_RECORDED'; erasePayload(record);
      return view(record);
    }),
    cancel: args => transaction(args, (draft, input, now) => {
      demand(exact(input, ['principal', 'requestId', 'expectedRevision']) && identifier(input.requestId), 'INVALID_ARGUMENTS');
      const record = findRecord(draft, input.principal, input.requestId); cancelRecord(record, now); return view(record);
    }),
    close: async () => {
      if (!accepting) { await tail; return; }
      accepting = false;
      const task = tail.then(async () => {
        try {
          if (poisoned && lock) { await lock.close(); lock = null; }
          else await releaseLock();
        }
        catch { throw new JournalError('LOCK_RELEASE_FAILED'); }
        finally { closed = true; secret.fill(0); state = null; }
      });
      tail = task.catch(() => {});
      await task;
    },
  });
}

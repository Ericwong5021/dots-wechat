import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_STATE_BYTES = 1024 * 1024;

export class PrivateStateStoreError extends Error {
  constructor(code, systemCode) {
    super(code);
    this.name = 'PrivateStateStoreError';
    this.code = code;
    if (systemCode) this.systemCode = systemCode;
  }
}

const fail = (code) => { throw new PrivateStateStoreError(code); };
const error = (code, cause) => cause instanceof PrivateStateStoreError
  ? cause : new PrivateStateStoreError(code, typeof cause?.code === 'string' ? cause.code : undefined);
const combine = (a, b) => a ? new AggregateError([a, b], 'STATE_STORE_MULTIPLE_ERRORS') : b;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const permissions = (stat) => stat.mode & 0o7777;

export async function createPrivateStateStore({ statePath } = {}) {
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath)
      || statePath.includes('\0') || statePath !== path.normalize(statePath)
      || statePath === path.parse(statePath).root || path.basename(statePath) === '.') {
    fail('STATE_PATH_INVALID');
  }
  if (typeof process.geteuid !== 'function' || !constants.O_NOFOLLOW) {
    fail('STATE_PLATFORM_UNSUPPORTED');
  }
  const uid = process.geteuid();
  const parent = path.dirname(statePath);
  const lockPath = `${statePath}.lock`;
  let parentIdentity;
  let lockHandle;
  let lockIdentity;

  async function checkParent() {
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
        || permissions(stat) !== 0o700 || await fs.realpath(parent) !== parent) {
      fail('STATE_PARENT_INSECURE');
    }
    if (parentIdentity && !sameFile(stat, parentIdentity)) fail('STATE_PARENT_CHANGED');
    parentIdentity ??= stat;
  }
  function checkRegular(stat, kind = 'STATE_FILE_INSECURE') {
    if (!stat.isFile() || stat.uid !== uid || permissions(stat) !== 0o600 || stat.nlink !== 1) fail(kind);
  }
  async function checkLock() {
    await checkParent();
    const stat = await fs.lstat(lockPath);
    checkRegular(stat, 'STATE_LOCK_INSECURE');
    if (!sameFile(stat, lockIdentity)) fail('STATE_LOCK_CHANGED');
  }
  async function openExisting() {
    let before;
    try { before = await fs.lstat(statePath); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    checkRegular(before);
    const handle = await fs.open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const after = await handle.stat();
      checkRegular(after);
      if (!sameFile(before, after)) fail('STATE_FILE_CHANGED');
      if (after.size > MAX_STATE_BYTES) fail('STATE_TOO_LARGE');
      return handle;
    } catch (e) {
      try { await handle.close(); } catch (closeError) { throw combine(error('STATE_READ_FAILED', e), error('STATE_CLOSE_FAILED', closeError)); }
      throw e;
    }
  }

  try {
    await checkParent();
    lockHandle = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    lockIdentity = await lockHandle.stat();
    await lockHandle.chmod(0o600);
    checkRegular(await lockHandle.stat(), 'STATE_LOCK_INSECURE');
    await checkLock();
  } catch (e) {
    let failure = e.code === 'EEXIST' ? new PrivateStateStoreError('STATE_LOCKED') : error('STATE_OPEN_FAILED', e);
    if (lockHandle) {
      try {
        await checkParent();
        const current = await fs.lstat(lockPath);
        if (!lockIdentity || !sameFile(current, lockIdentity)) fail('STATE_LOCK_CHANGED');
        await fs.unlink(lockPath);
      } catch (cleanupError) { failure = combine(failure, error('STATE_LOCK_CLEANUP_FAILED', cleanupError)); }
      try { await lockHandle.close(); }
      catch (closeError) { failure = combine(failure, error('STATE_CLOSE_FAILED', closeError)); }
    }
    throw failure;
  }

  let tail = Promise.resolve();
  let closing = false;
  let closePromise;
  function enqueue(fn) {
    if (closing) return Promise.reject(new PrivateStateStoreError('STATE_STORE_CLOSED'));
    const result = tail.then(fn);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  async function load() {
    return enqueue(async () => {
      let handle;
      let result;
      let failure;
      try {
        await checkLock();
        handle = await openExisting();
        if (!handle) return null;
        const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_STATE_BYTES) fail('STATE_TOO_LARGE');
        let json;
        try { json = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
        catch { fail('STATE_INVALID_JSON'); }
        try { result = JSON.parse(json); } catch { fail('STATE_INVALID_JSON'); }
        await checkLock();
      } catch (e) { failure = error('STATE_READ_FAILED', e); }
      if (handle) {
        try { await handle.close(); }
        catch (e) { failure = combine(failure, error('STATE_CLOSE_FAILED', e)); }
      }
      if (failure) throw failure;
      return result;
    });
  }
  async function save(snapshot) {
    let buffer;
    try {
      const json = JSON.stringify(snapshot);
      if (json === undefined) fail('STATE_NOT_JSON');
      buffer = Buffer.from(json, 'utf8');
      if (buffer.length > MAX_STATE_BYTES) fail('STATE_TOO_LARGE');
    } catch (e) { throw error('STATE_NOT_JSON', e); }
    return enqueue(async () => {
      let temporaryPath;
      let temporaryIdentity;
      let temporaryHandle;
      let directoryHandle;
      let committed = false;
      let failure;
      try {
        await checkLock();
        const oldHandle = await openExisting();
        if (oldHandle) await oldHandle.close();
        temporaryPath = path.join(parent, `.${path.basename(statePath)}.tmp-${randomUUID()}`);
        temporaryHandle = await fs.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryIdentity = await temporaryHandle.stat();
        await temporaryHandle.chmod(0o600);
        checkRegular(await temporaryHandle.stat());
        await temporaryHandle.writeFile(buffer);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        await checkLock();
        const currentHandle = await openExisting();
        if (currentHandle) await currentHandle.close();
        const tempStat = await fs.lstat(temporaryPath);
        checkRegular(tempStat);
        if (!sameFile(tempStat, temporaryIdentity)) fail('STATE_TEMP_CHANGED');
        directoryHandle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (!sameFile(await directoryHandle.stat(), parentIdentity)) fail('STATE_PARENT_CHANGED');
        await fs.rename(temporaryPath, statePath);
        committed = true;
        await directoryHandle.sync();
      } catch (e) {
        failure = committed
          ? new PrivateStateStoreError('STATE_COMMIT_UNCERTAIN', typeof e?.code === 'string' ? e.code : undefined)
          : error('STATE_WRITE_FAILED', e);
      }
      if (temporaryHandle) {
        try { await temporaryHandle.close(); }
        catch (e) { failure = combine(failure, error('STATE_CLOSE_FAILED', e)); }
      }
      if (!committed && temporaryPath && temporaryIdentity) {
        try {
          await checkParent();
          const remaining = await fs.lstat(temporaryPath);
          if (!sameFile(remaining, temporaryIdentity)) fail('STATE_TEMP_CHANGED');
          await fs.unlink(temporaryPath);
        } catch (e) { failure = combine(failure, error('STATE_TEMP_CLEANUP_FAILED', e)); }
      }
      if (directoryHandle) {
        try { await directoryHandle.close(); }
        catch (e) { failure = combine(failure, new PrivateStateStoreError(committed ? 'STATE_COMMIT_UNCERTAIN' : 'STATE_CLOSE_FAILED', e?.code)); }
      }
      if (failure) throw failure;
    });
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = tail.then(async () => {
      let failure;
      try {
        await checkLock();
        await fs.unlink(lockPath);
      } catch (e) { failure = error('STATE_LOCK_RELEASE_FAILED', e); }
      try { await lockHandle.close(); }
      catch (e) { failure = combine(failure, error('STATE_CLOSE_FAILED', e)); }
      if (failure) throw failure;
    });
    return closePromise;
  }
  return Object.freeze({ load, save, close });
}

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export const WEIXIN_BINDING_PROTOCOL = Object.freeze({
  upstreamCommit: '24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c',
  origin: 'https://ilinkai.weixin.qq.com',
  clientVersion: '132105',
  sessionTtlMs: 300_000,
  maxResponseBytes: 16_384,
  maxPolls: 300,
});

export class WeixinBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WeixinBindingError';
    this.code = code;
  }
}

const fail = (code) => { throw new WeixinBindingError(code); };
const safeResult = (value) => Object.freeze(value);
const validString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,256}$/.test(value);
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;

function checkedBaseUrl(value) {
  if (value === undefined || value === '') return WEIXIN_BINDING_PROTOCOL.origin;
  if (value !== WEIXIN_BINDING_PROTOCOL.origin && value !== `${WEIXIN_BINDING_PROTOCOL.origin}/`) fail('UNSUPPORTED_PROVIDER_BASE_URL');
  return WEIXIN_BINDING_PROTOCOL.origin;
}

function applicationHeaders() {
  return { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': WEIXIN_BINDING_PROTOCOL.clientVersion };
}

async function boundedJson(response, requestedUrl) {
  if (!response || response.status !== 200 || response.redirected === true) fail('PROVIDER_HTTP_REJECTED');
  if (response.url && response.url !== requestedUrl) fail('PROVIDER_HTTP_REJECTED');
  if (!/^application\/(?:json|octet-stream)(?:\s*;|$)/i.test(response.headers?.get('content-type') ?? '')) fail('PROVIDER_RESPONSE_INVALID');
  const length = response.headers?.get('content-length');
  if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > WEIXIN_BINDING_PROTOCOL.maxResponseBytes)) fail('PROVIDER_RESPONSE_TOO_LARGE');
  if (!response.body || typeof response.body.getReader !== 'function') fail('PROVIDER_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('PROVIDER_RESPONSE_INVALID');
      size += value.byteLength;
      if (size > WEIXIN_BINDING_PROTOCOL.maxResponseBytes) fail('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  let result;
  try {
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    fail('PROVIDER_RESPONSE_INVALID');
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) fail('PROVIDER_RESPONSE_INVALID');
  for (const key of ['ret', 'errcode']) {
    if (Object.hasOwn(result, key) && result[key] !== 0) fail('PROVIDER_REJECTED');
  }
  return result;
}

async function checkedStoragePath(credentialPath) {
  if (typeof credentialPath !== 'string' || credentialPath.length > 4096 || !path.isAbsolute(credentialPath) || path.normalize(credentialPath) !== credentialPath || /[\x00-\x1f\x7f]/.test(credentialPath)) fail('INVALID_CREDENTIAL_PATH');
  if (credentialPath.split(path.sep).some((part) => ['.openclaw', '.hermes'].includes(part.toLowerCase()))) fail('EXISTING_ACCOUNT_STORAGE_FORBIDDEN');
  const directory = path.dirname(credentialPath);
  const parent = path.dirname(directory);
  if (directory === parent || path.basename(credentialPath) !== 'credentials.json') fail('INVALID_CREDENTIAL_PATH');
  try {
    if (await realpath(parent) !== parent) fail('NON_CANONICAL_CREDENTIAL_PATH');
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('NON_CANONICAL_CREDENTIAL_PATH');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) fail('UNSAFE_CREDENTIAL_PARENT');
    if ((metadata.mode & 0o022) !== 0) fail('UNSAFE_CREDENTIAL_PARENT');
  } catch (error) {
    if (error instanceof WeixinBindingError) throw error;
    fail('CREDENTIAL_PARENT_UNAVAILABLE');
  }
  return directory;
}

export function createWeixinQrBinding({ enabled = false, fetchImpl, now = Date.now, requestTimeoutMs = 15_000, pollTimeoutMs = 35_000, onObservation } = {}) {
  if (typeof now !== 'function') fail('INVALID_CLOCK');
  if (onObservation !== undefined && typeof onObservation !== 'function') fail('INVALID_OBSERVER');
  function observe(value) {
    try { onObservation?.(safeResult(value)); } catch {}
  }
  for (const timeout of [requestTimeoutMs, pollTimeoutMs]) {
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 35_000) fail('INVALID_TIMEOUT');
  }
  const proofs = new WeakMap();
  let active = null;
  let confirmedRecord = null;
  let requested = false;
  let disposed = false;
  let inFlightController = null;

  function timestamp() {
    const value = now();
    if (!validTime(value)) fail('INVALID_CLOCK');
    return value;
  }

  function requireEnabled() {
    if (enabled !== true) fail('BINDING_DISABLED');
    if (disposed) fail('BINDING_DISPOSED');
    if (typeof fetchImpl !== 'function') fail('EXPLICIT_TRANSPORT_REQUIRED');
  }

  function sessionFor(session) {
    requireEnabled();
    if (!active || session !== active.handle || active.closed) fail('INVALID_BINDING_SESSION');
    if (timestamp() < active.startedAt || timestamp() >= active.expiresAtMs) {
      active.closed = true;
      active.qrcode = '';
      active.qrPayload = '';
      active.pendingVerifyCode = undefined;
      fail('BINDING_EXPIRED');
    }
    return active;
  }

  async function request(url, options, timeoutMs) {
    const controller = new AbortController();
    inFlightController = controller;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          let response;
          try {
            response = await fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
          } catch {
            fail('PROVIDER_REQUEST_FAILED');
          }
          return boundedJson(response, url);
        }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new WeixinBindingError('PROVIDER_REQUEST_TIMEOUT'));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof WeixinBindingError) throw error;
      fail('PROVIDER_REQUEST_FAILED');
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (inFlightController === controller) inFlightController = null;
    }
  }

  async function requestQrOnce() {
    requireEnabled();
    if (requested) fail('QR_ALREADY_REQUESTED');
    requested = true;
    const startedAt = timestamp();
    const headers = {
      ...applicationHeaders(),
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
    };
    const result = await request(`${WEIXIN_BINDING_PROTOCOL.origin}/ilink/bot/get_bot_qrcode?bot_type=3`, { method: 'POST', headers, body: '{"local_token_list":[]}' }, requestTimeoutMs);
    requireEnabled();
    if (!validString(result.qrcode, 2048) || typeof result.qrcode_img_content !== 'string' || result.qrcode_img_content.length < 1 || Buffer.byteLength(result.qrcode_img_content, 'utf8') > 4096 || /[\x00-\x1f\x7f<>]/.test(result.qrcode_img_content) || /^(?:javascript|data|file|blob):/i.test(result.qrcode_img_content)) fail('PROVIDER_QR_INVALID');
    const handle = safeResult({});
    active = { handle, qrcode: result.qrcode, qrPayload: result.qrcode_img_content, startedAt, expiresAtMs: startedAt + WEIXIN_BINDING_PROTOCOL.sessionTtlMs, closed: false, busy: false, status: 'wait', pollCount: 0, currentApiBaseUrl: WEIXIN_BINDING_PROTOCOL.origin, pendingVerifyCode: undefined, redirectPending: undefined, redirectCount: 0 };
    observe({ phase: 'qr_response', hasQrIdentifier: true, hasDisplayPayload: true, pairedFromSameResponse: true });
    sessionFor(handle);
    return safeResult({ status: 'qr_ready', session: handle, expiresAtMs: active.expiresAtMs });
  }

  function qrDisplayPayload(session) {
    const state = sessionFor(session);
    return safeResult({ format: 'opaque-qr-payload', payload: state.qrPayload });
  }

  async function pollOnce(session, { verifyCode } = {}) {
    const state = sessionFor(session);
    if (state.busy) fail('POLL_ALREADY_RUNNING');
    if (state.pollCount >= WEIXIN_BINDING_PROTOCOL.maxPolls) fail('POLL_LIMIT_REACHED');
    if (state.redirectPending) fail('PROVIDER_ORIGIN_VERIFICATION_REQUIRED');
    if (verifyCode !== undefined) {
      if (typeof verifyCode !== 'string' || !/^\d{1,12}$/.test(verifyCode) || (state.status !== 'need_verifycode' && state.pendingVerifyCode !== verifyCode)) fail('INVALID_VERIFICATION_CODE');
      state.pendingVerifyCode = verifyCode;
    }
    if (state.status === 'need_verifycode' && state.pendingVerifyCode === undefined) fail('VERIFICATION_CODE_REQUIRED');
    state.busy = true;
    state.pollCount += 1;
    let query = `qrcode=${encodeURIComponent(state.qrcode)}`;
    if (state.pendingVerifyCode !== undefined) query += `&verify_code=${encodeURIComponent(state.pendingVerifyCode)}`;
    observe({ phase: 'poll_request', queryMatchesSession: new URLSearchParams(query).get('qrcode') === state.qrcode, hasVerificationCode: state.pendingVerifyCode !== undefined, verifiedOrigin: state.currentApiBaseUrl === WEIXIN_BINDING_PROTOCOL.origin });
    try {
      const result = await request(`${state.currentApiBaseUrl}/ilink/bot/get_qrcode_status?${query}`, { method: 'GET', headers: applicationHeaders() }, pollTimeoutMs);
      sessionFor(session);
      const statuses = ['wait', 'scaned', 'need_verifycode', 'expired', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect', 'confirmed'];
      observe({ phase: 'poll_response', providerStatus: statuses.includes(result.status) ? result.status : 'unrecognized', hasRedirectHost: typeof result.redirect_host === 'string', hasBotToken: typeof result.bot_token === 'string' && result.bot_token.length > 0, hasBotId: typeof result.ilink_bot_id === 'string' && result.ilink_bot_id.length > 0, hasOwnerId: typeof result.ilink_user_id === 'string' && result.ilink_user_id.length > 0, hasBaseUrl: typeof result.baseurl === 'string' });
      if (['wait', 'scaned', 'need_verifycode'].includes(result.status)) {
        state.status = result.status;
        if (result.status === 'scaned' || result.status === 'need_verifycode') state.pendingVerifyCode = undefined;
        return safeResult({ status: result.status, requiresUserAction: result.status === 'need_verifycode' });
      }
      if (result.status === 'scaned_but_redirect') {
        if (++state.redirectCount > 4) fail('PROVIDER_REDIRECT_LIMIT');
        const host = result.redirect_host;
        if (typeof host !== 'string' || host.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host)) fail('PROVIDER_REDIRECT_INVALID');
        if (host !== new URL(WEIXIN_BINDING_PROTOCOL.origin).hostname) {
          state.redirectPending = host;
          return safeResult({ status: 'redirect_requires_verification', providerHost: host, requiresUserAction: true });
        }
        state.currentApiBaseUrl = `https://${host}`;
        return safeResult({ status: 'scaned_but_redirect', requiresUserAction: false });
      }
      state.closed = true;
      state.qrcode = '';
      state.qrPayload = '';
      state.pendingVerifyCode = undefined;
      if (['expired', 'verify_code_blocked'].includes(result.status)) return safeResult({ status: result.status, requiresNewApproval: true });
      if (result.status === 'binded_redirect') fail('EXISTING_BINDING_NOT_IMPORTED');
      if (result.status !== 'confirmed') fail('PROVIDER_STATUS_INVALID');
      const baseUrl = checkedBaseUrl(result.baseurl);
      if (!validString(result.bot_token, 4096) || !validId(result.ilink_bot_id) || !validId(result.ilink_user_id)) fail('PROVIDER_BINDING_INVALID');
      const proof = safeResult({});
      confirmedRecord = { botToken: result.bot_token, botId: result.ilink_bot_id, ownerUserId: result.ilink_user_id, baseUrl, confirmedAtMs: timestamp(), consumed: false };
      proofs.set(proof, confirmedRecord);
      return safeResult({ status: 'confirmed', proof, summary: safeResult({ provider: 'tencent-weixin-ilink', baseUrl, ownerRestricted: true, persisted: false }) });
    } finally {
      state.busy = false;
    }
  }

  async function saveConfirmedBinding(proof, { credentialPath, allowPersistence = false } = {}) {
    requireEnabled();
    if (allowPersistence !== true) fail('PERSISTENCE_NOT_APPROVED');
    const record = proofs.get(proof);
    if (!record || record.consumed) fail('INVALID_CONFIRMATION_PROOF');
    function checkSaveActive() {
      const currentTime = timestamp();
      if (disposed) fail('BINDING_DISPOSED');
      if (currentTime < record.confirmedAtMs || currentTime - record.confirmedAtMs >= WEIXIN_BINDING_PROTOCOL.sessionTtlMs) fail('CONFIRMATION_EXPIRED');
    }
    checkSaveActive();
    const directory = await checkedStoragePath(credentialPath);
    if (record.consumed) fail('INVALID_CONFIRMATION_PROOF');
    checkSaveActive();
    record.consumed = true;
    let createdDirectory = false;
    let createdFile = false;
    let file;
    try {
      await mkdir(directory, { mode: 0o700 });
      createdDirectory = true;
      checkSaveActive();
      const directoryStat = await lstat(directory);
      checkSaveActive();
      const canonicalDirectory = await realpath(directory);
      checkSaveActive();
      if ((directoryStat.mode & 0o777) !== 0o700 || !directoryStat.isDirectory() || directoryStat.isSymbolicLink() || canonicalDirectory !== directory) fail('UNSAFE_CREDENTIAL_DIRECTORY');
      file = await open(credentialPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      createdFile = true;
      checkSaveActive();
      const fileStat = await file.stat();
      checkSaveActive();
      if ((fileStat.mode & 0o777) !== 0o600) fail('UNSAFE_CREDENTIAL_FILE');
      const document = { schemaVersion: 1, provider: 'tencent-weixin-ilink', baseUrl: record.baseUrl, botToken: record.botToken, botId: record.botId, ownerUserId: record.ownerUserId, createdAtMs: record.confirmedAtMs };
      await file.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
      checkSaveActive();
      await file.sync();
      checkSaveActive();
      await file.close();
      file = undefined;
      checkSaveActive();
      record.botToken = '';
      record.botId = '';
      record.ownerUserId = '';
      return safeResult({ status: 'saved', provider: 'tencent-weixin-ilink', ownerRestricted: true, persisted: true });
    } catch {
      if (file) await file.close().catch(() => {});
      if (createdFile) await unlink(credentialPath).catch(() => {});
      if (createdDirectory) await rmdir(directory).catch(() => {});
      record.botToken = '';
      record.botId = '';
      record.ownerUserId = '';
      fail('CREDENTIAL_SAVE_FAILED_NO_RETRY');
    }
  }

  function dispose() {
    disposed = true;
    if (active) {
      active.closed = true;
      active.qrcode = '';
      active.qrPayload = '';
      active.pendingVerifyCode = undefined;
    }
    if (confirmedRecord) {
      confirmedRecord.consumed = true;
      confirmedRecord.botToken = '';
      confirmedRecord.botId = '';
      confirmedRecord.ownerUserId = '';
    }
    inFlightController?.abort();
  }

  return safeResult({ requestQrOnce, qrDisplayPayload, pollOnce, saveConfirmedBinding, dispose });
}

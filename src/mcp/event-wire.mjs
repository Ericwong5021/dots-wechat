import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_BODY_BYTES = 262144;
const DATA_FIELDS = ['request_id', 'message_id', 'event_id', 'subscription_id', 'binding_id', 'generation', 'text'];
const REQUIRED_HEADERS = ['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id'];
const demand = (value, code) => { if (!value) throw new EventWireError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key).enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, fields) => record(value) && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const natural = value => Number.isSafeInteger(value) && value >= 0;
const utf8 = value => typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value;
const identifier = value => utf8(value) && value.length >= 1 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
const headerIdentifier = value => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/u.test(value);
const webhookIdentifier = value => headerIdentifier(value) && !value.includes('.');
const challengeValid = value => utf8(value) && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
const freeze = value => { if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const equalText = (left, right) => timingSafeEqual(createHmac('sha256', Buffer.alloc(32)).update(left, 'utf8').digest(), createHmac('sha256', Buffer.alloc(32)).update(right, 'utf8').digest());

export class EventWireError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EventWireError';
    this.code = code;
  }
}

export function decodeSigningSecret(secret) {
  demand(typeof secret === 'string' && secret.length >= 38 && secret.length <= 94 && secret.startsWith('whsec_'), 'INVALID_SECRET');
  const encoded = secret.slice(6);
  demand(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded), 'INVALID_SECRET');
  const key = Buffer.from(encoded, 'base64');
  demand(key.length >= 24 && key.length <= 64 && key.toString('base64') === encoded, 'INVALID_SECRET');
  return key;
}

export function canonicalCallbackUrlFormat(value) {
  demand(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020\u007f\\]/u.test(value) && /^https:\/\//iu.test(value), 'INVALID_CALLBACK_URL');
  let url;
  try { url = new URL(value); } catch { throw new EventWireError('INVALID_CALLBACK_URL'); }
  demand(url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.hash && !value.includes('#') && url.href.length <= 2048, 'INVALID_CALLBACK_URL');
  return url.href;
}

function rawBytes(rawBody) {
  demand(Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array, 'RAW_BYTES_REQUIRED');
  demand(rawBody.byteLength > 0 && rawBody.byteLength <= MAX_BODY_BYTES, 'INVALID_BODY_SIZE');
  return Buffer.from(rawBody);
}

function timestampHeader(value) {
  demand(typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) && natural(Number(value)), 'INVALID_SIGNING_TIMESTAMP');
  return Number(value);
}

function signatureBytes(secret, webhookId, timestamp, body) {
  demand(webhookIdentifier(webhookId), 'INVALID_WEBHOOK_ID');
  timestampHeader(timestamp);
  return createHmac('sha256', decodeSigningSecret(secret)).update(`${webhookId}.${timestamp}.`, 'utf8').update(body).digest();
}

export function signRawBody({ secret, webhookId, signingTimestamp, rawBody }) {
  demand(natural(signingTimestamp), 'INVALID_SIGNING_TIMESTAMP');
  return `v1,${signatureBytes(secret, webhookId, String(signingTimestamp), rawBytes(rawBody)).toString('base64')}`;
}

export function normalizeWireHeaders(headers) {
  demand(record(headers), 'INVALID_HEADERS');
  const output = Object.create(null);
  for (const name of Object.keys(headers)) {
    demand(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name), 'INVALID_HEADERS');
    const lower = name.toLowerCase();
    demand(!Object.hasOwn(output, lower), 'DUPLICATE_HEADER');
    const value = headers[name];
    demand(typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value), 'INVALID_HEADERS');
    output[lower] = value;
  }
  demand(REQUIRED_HEADERS.every(name => Object.hasOwn(output, name)), 'MISSING_HEADER');
  demand(output['content-type'] === 'application/json', 'INVALID_CONTENT_TYPE');
  demand(webhookIdentifier(output['webhook-id']), 'INVALID_WEBHOOK_ID');
  demand(headerIdentifier(output['x-mcp-subscription-id']), 'INVALID_SUBSCRIPTION_ID');
  timestampHeader(output['webhook-timestamp']);
  const signatures = output['webhook-signature'].split(' ');
  demand(signatures.length <= 8 && signatures.every(signature => /^v1,[A-Za-z0-9+/]{43}=$/u.test(signature) && Buffer.from(signature.slice(3), 'base64').toString('base64') === signature.slice(3)), 'INVALID_SIGNATURE_HEADER');
  return freeze(output);
}

export function verifyRawBody({ secret, headers, rawBody, nowSeconds, toleranceSeconds = 300, expectedSubscriptionId }) {
  demand(natural(nowSeconds) && natural(toleranceSeconds) && toleranceSeconds <= 300, 'INVALID_FRESHNESS_POLICY');
  demand(headerIdentifier(expectedSubscriptionId), 'INVALID_SUBSCRIPTION_ID');
  const normalized = normalizeWireHeaders(headers);
  demand(normalized['x-mcp-subscription-id'] === expectedSubscriptionId, 'SUBSCRIPTION_MISMATCH');
  const timestamp = timestampHeader(normalized['webhook-timestamp']);
  demand(Math.abs(nowSeconds - timestamp) <= toleranceSeconds, 'STALE_SIGNATURE');
  const expected = signatureBytes(secret, normalized['webhook-id'], normalized['webhook-timestamp'], rawBytes(rawBody));
  let matched = 0;
  for (const signature of normalized['webhook-signature'].split(' ')) matched |= Number(timingSafeEqual(expected, Buffer.from(signature.slice(3), 'base64')));
  demand(matched > 0, 'SIGNATURE_MISMATCH');
  return freeze({ webhookId: normalized['webhook-id'], subscriptionId: expectedSubscriptionId, signingTimestamp: timestamp });
}

function parseJson(rawBody) {
  const bytes = rawBytes(rawBody);
  const text = bytes.toString('utf8');
  demand(Buffer.from(text, 'utf8').equals(bytes), 'INVALID_UTF8');
  try { return JSON.parse(text); } catch { throw new EventWireError('INVALID_JSON'); }
}

export function validateOwnerEvent(event, { expectedSubscriptionId, expectedBindingId, expectedGeneration } = {}) {
  demand(exact(event, ['eventId', 'name', 'timestamp', 'data', 'cursor']), 'INVALID_EVENT');
  demand(webhookIdentifier(event.eventId) && event.name === 'weixin.owner_message' && event.cursor === null, 'INVALID_EVENT');
  demand(typeof event.timestamp === 'string' && validOccurrenceTimestamp(event.timestamp), 'INVALID_EVENT_TIMESTAMP');
  demand(exact(event.data, DATA_FIELDS), 'INVALID_EVENT_DATA');
  demand(DATA_FIELDS.filter(key => !['generation', 'text'].includes(key)).every(key => identifier(event.data[key])), 'INVALID_EVENT_DATA');
  demand(headerIdentifier(event.data.subscription_id) && natural(event.data.generation) && event.data.generation > 0, 'INVALID_EVENT_DATA');
  const text = event.data.text;
  demand(utf8(text) && text.trim().length > 0 && text.length <= 4000 && Buffer.byteLength(text, 'utf8') <= 16000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text), 'INVALID_EVENT_TEXT');
  demand(event.eventId === event.data.event_id, 'EVENT_ID_MISMATCH');
  if (expectedSubscriptionId !== undefined) demand(event.data.subscription_id === expectedSubscriptionId, 'SUBSCRIPTION_MISMATCH');
  if (expectedBindingId !== undefined) demand(event.data.binding_id === expectedBindingId, 'BINDING_MISMATCH');
  if (expectedGeneration !== undefined) demand(event.data.generation === expectedGeneration, 'GENERATION_MISMATCH');
  return freeze(structuredClone(event));
}

function validOccurrenceTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month), 0);
  const days = calendar.getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && (zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59));
}

function encodeRequest({ callbackUrl, secret, webhookId, subscriptionId, signingTimestamp, value }) {
  const url = canonicalCallbackUrlFormat(callbackUrl);
  demand(headerIdentifier(subscriptionId), 'INVALID_SUBSCRIPTION_ID');
  const body = JSON.stringify(value);
  const rawBody = Buffer.from(body, 'utf8');
  const headers = freeze({
    'Content-Type': 'application/json',
    'webhook-id': webhookId,
    'webhook-timestamp': String(signingTimestamp),
    'webhook-signature': signRawBody({ secret, webhookId, signingTimestamp, rawBody }),
    'X-MCP-Subscription-Id': subscriptionId,
  });
  return Object.freeze({ url, method: 'POST', redirect: 'error', headers, body });
}

export function encodeOwnerEventRequest({ event, callbackUrl, secret, subscriptionId, signingTimestamp }) {
  const checked = validateOwnerEvent(event, { expectedSubscriptionId: subscriptionId });
  return encodeRequest({ callbackUrl, secret, webhookId: checked.eventId, subscriptionId, signingTimestamp, value: checked });
}

export function decodeOwnerEventRequest({ method, secret, headers, rawBody, nowSeconds, toleranceSeconds, expectedSubscriptionId, expectedBindingId, expectedGeneration }) {
  demand(method === 'POST', 'INVALID_METHOD');
  const snapshot = rawBytes(rawBody);
  const metadata = verifyRawBody({ secret, headers, rawBody: snapshot, nowSeconds, toleranceSeconds, expectedSubscriptionId });
  const event = validateOwnerEvent(parseJson(snapshot), { expectedSubscriptionId, expectedBindingId, expectedGeneration });
  demand(metadata.webhookId === event.eventId, 'EVENT_ID_MISMATCH');
  return event;
}

export function encodeVerificationRequest({ challenge, callbackUrl, secret, webhookId, subscriptionId, signingTimestamp }) {
  demand(challengeValid(challenge), 'INVALID_CHALLENGE');
  return encodeRequest({ callbackUrl, secret, webhookId, subscriptionId, signingTimestamp, value: { type: 'verification', challenge } });
}

export function decodeVerificationRequest({ method, secret, headers, rawBody, nowSeconds, toleranceSeconds, expectedSubscriptionId }) {
  demand(method === 'POST', 'INVALID_METHOD');
  const snapshot = rawBytes(rawBody);
  verifyRawBody({ secret, headers, rawBody: snapshot, nowSeconds, toleranceSeconds, expectedSubscriptionId });
  const body = parseJson(snapshot);
  demand(exact(body, ['type', 'challenge']) && body.type === 'verification' && challengeValid(body.challenge), 'INVALID_VERIFICATION_BODY');
  return freeze({ challenge: body.challenge });
}

export function encodeVerificationResponse(challenge) {
  demand(challengeValid(challenge), 'INVALID_CHALLENGE');
  return Buffer.from(JSON.stringify({ challenge }), 'utf8');
}

export function validateVerificationResponse({ status, rawBody, expectedChallenge, issuedAtSeconds, expiresAtSeconds, nowSeconds, consumed }) {
  demand(challengeValid(expectedChallenge), 'INVALID_CHALLENGE');
  demand(natural(issuedAtSeconds) && natural(expiresAtSeconds) && natural(nowSeconds) && expiresAtSeconds > issuedAtSeconds && expiresAtSeconds - issuedAtSeconds <= 300 && typeof consumed === 'boolean', 'INVALID_CHALLENGE_STATE');
  demand(!consumed, 'CHALLENGE_ALREADY_CONSUMED');
  demand(nowSeconds >= issuedAtSeconds && nowSeconds < expiresAtSeconds, 'CHALLENGE_EXPIRED');
  demand(Number.isInteger(status) && status >= 200 && status <= 299, 'CHALLENGE_RESPONSE_REJECTED');
  const body = parseJson(rawBody);
  demand(exact(body, ['challenge']) && challengeValid(body.challenge) && equalText(expectedChallenge, body.challenge), 'CHALLENGE_MISMATCH');
  return freeze({ verified: true, consumed: true });
}

export const buildVerificationRequest = encodeVerificationRequest;
export const buildSignedEventRequest = encodeOwnerEventRequest;

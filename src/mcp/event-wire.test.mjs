import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  EventWireError, MAX_BODY_BYTES, decodeSigningSecret, canonicalCallbackUrlFormat,
  signRawBody, normalizeWireHeaders, verifyRawBody, validateOwnerEvent,
  buildSignedEventRequest, decodeOwnerEventRequest, buildVerificationRequest,
  decodeVerificationRequest, encodeVerificationResponse, validateVerificationResponse,
} from './event-wire.mjs';

const SECRET = `whsec_${Buffer.alloc(32, 0x42).toString('base64')}`;
const OTHER_SECRET = `whsec_${Buffer.alloc(32, 0x53).toString('base64')}`;
const NOW = 1790812800;
const SUB = 'sub_synthetic_only';
const CHALLENGE = 'synthetic-challenge-only';
const CALLBACK = 'https://receiver.example.invalid/synthetic/callback';
const fixture = () => ({
  eventId: 'evt_synthetic_only',
  name: 'weixin.owner_message',
  timestamp: '2026-10-01T00:00:00Z',
  data: {
    request_id: 'request_synthetic_only', message_id: 'message_synthetic_only',
    event_id: 'evt_synthetic_only', subscription_id: SUB,
    binding_id: 'binding_synthetic_only', generation: 1, text: '纯合成文本 fixture',
  },
  cursor: null,
});
const encodeEvent = event => buildSignedEventRequest({ event, callbackUrl: CALLBACK, secret: SECRET, subscriptionId: SUB, signingTimestamp: NOW });
const encodeChallenge = () => buildVerificationRequest({ challenge: CHALLENGE, callbackUrl: CALLBACK, secret: SECRET, webhookId: 'msg_synthetic_verify', subscriptionId: SUB, signingTimestamp: NOW });
const verification = request => ({ secret: SECRET, headers: request.headers, rawBody: Buffer.from(request.body), nowSeconds: NOW, expectedSubscriptionId: SUB });
const echoInput = () => ({ status: 200, rawBody: encodeVerificationResponse(CHALLENGE), expectedChallenge: CHALLENGE, issuedAtSeconds: NOW, expiresAtSeconds: NOW + 60, nowSeconds: NOW + 1, consumed: false });
const rejects = (operation, code) => assert.throws(operation, error => error instanceof EventWireError && error.code === code);
const independentlySigned = (rawBody, webhookId = 'evt_synthetic_only') => ({
  'Content-Type': 'application/json', 'webhook-id': webhookId,
  'webhook-timestamp': String(NOW), 'X-MCP-Subscription-Id': SUB,
  'webhook-signature': `v1,${createHmac('sha256', Buffer.alloc(32, 0x42)).update(`${webhookId}.${NOW}.`).update(rawBody).digest('base64')}`,
});

test('synthetic known-answer HMAC matches an independent Python calculation', () => {
  const wire = encodeChallenge();
  assert.equal(wire.body, '{"type":"verification","challenge":"synthetic-challenge-only"}');
  assert.equal(wire.headers['webhook-signature'], 'v1,06Eum0eW6ftKUnc0Gk9xW9cCZazqGCKz0gR3pNgFfYg=');
  assert.equal(wire.method, 'POST');
  assert.equal(wire.redirect, 'error');
  assert.equal(wire.url, CALLBACK);
  assert.ok(Object.isFrozen(wire));
  assert.ok(Object.isFrozen(wire.headers));
});

test('secret boundaries and canonical base64 are enforced', () => {
  for (const length of [24, 32, 64]) assert.equal(decodeSigningSecret(`whsec_${Buffer.alloc(length, 0x42).toString('base64')}`).length, length);
  for (const secret of [null, 'secret', `whsec_${Buffer.alloc(23).toString('base64')}`, `whsec_${Buffer.alloc(65).toString('base64')}`, 'whsec_' + 'A'.repeat(100000), SECRET + '\n', SECRET.slice(0, -1), SECRET.replace(/=$/u, '-'), SECRET.replace(/I=$/u, 'J=')]) rejects(() => decodeSigningSecret(secret), 'INVALID_SECRET');
});

test('URL format requires HTTPS without credentials, fragment, controls or backslash', () => {
  assert.equal(canonicalCallbackUrlFormat('https://RECEIVER.example.invalid:443/hook?q=synthetic'), 'https://receiver.example.invalid/hook?q=synthetic');
  for (const url of ['http://receiver.example.invalid/', 'https://user:pass@receiver.example.invalid/', 'https://receiver.example.invalid/#', 'https://receiver.example.invalid/#fragment', ' https://receiver.example.invalid/', 'https://receiver.example.invalid/\n', 'https:/receiver.example.invalid/', 'https://receiver.example.invalid\\path', 'https://', 123, 'https://receiver.example.invalid/' + 'x'.repeat(2048)]) rejects(() => canonicalCallbackUrlFormat(url), 'INVALID_CALLBACK_URL');
});

test('format-only validation makes no claim about DNS or globally routable addresses', () => {
  assert.equal(canonicalCallbackUrlFormat('https://127.0.0.1/synthetic'), 'https://127.0.0.1/synthetic');
  assert.equal(canonicalCallbackUrlFormat('https://localhost/synthetic'), 'https://localhost/synthetic');
});

test('event roundtrip preserves application data and correlation', () => {
  const event = fixture();
  const wire = encodeEvent(event);
  assert.equal(wire.headers['webhook-id'], event.eventId);
  const decoded = decodeOwnerEventRequest({ method: 'POST', ...verification(wire), expectedBindingId: 'binding_synthetic_only', expectedGeneration: 1 });
  assert.deepEqual(decoded, event);
  assert.ok(Object.isFrozen(decoded.data));
  assert.ok(!Object.isFrozen(event));
});

test('verification request and echo roundtrip', () => {
  const request = encodeChallenge();
  assert.deepEqual(decodeVerificationRequest({ method: 'POST', ...verification(request) }), { challenge: CHALLENGE });
  assert.deepEqual(validateVerificationResponse(echoInput()), { verified: true, consumed: true });
  assert.deepEqual(validateVerificationResponse({ ...echoInput(), status: 299 }), { verified: true, consumed: true });
});

test('challenge response requires successful status and exact schema', () => {
  for (const status of [199, 300, 302, 410, 500, '200']) rejects(() => validateVerificationResponse({ ...echoInput(), status }), 'CHALLENGE_RESPONSE_REJECTED');
  for (const body of [{ challenge: 'different-synthetic' }, { challenge: CHALLENGE, verified: true }, [], null, { challenge: 12 }, { challenge: '' }]) rejects(() => validateVerificationResponse({ ...echoInput(), rawBody: Buffer.from(JSON.stringify(body)) }), 'CHALLENGE_MISMATCH');
});

test('challenge lifecycle is caller-owned, explicit, short-lived and single-use', () => {
  rejects(() => validateVerificationResponse({ ...echoInput(), consumed: true }), 'CHALLENGE_ALREADY_CONSUMED');
  rejects(() => validateVerificationResponse({ ...echoInput(), consumed: undefined }), 'INVALID_CHALLENGE_STATE');
  rejects(() => validateVerificationResponse({ ...echoInput(), nowSeconds: NOW + 60 }), 'CHALLENGE_EXPIRED');
  rejects(() => validateVerificationResponse({ ...echoInput(), nowSeconds: NOW - 1 }), 'CHALLENGE_EXPIRED');
  rejects(() => validateVerificationResponse({ ...echoInput(), expiresAtSeconds: NOW + 301 }), 'INVALID_CHALLENGE_STATE');
});

test('challenge UTF8, bounds and control rejection', () => {
  assert.deepEqual(validateVerificationResponse({ ...echoInput(), expectedChallenge: '合成挑战🧪', rawBody: encodeVerificationResponse('合成挑战🧪') }), { verified: true, consumed: true });
  for (const challenge of ['', '\ud800', 'x'.repeat(4097), 'x\n', null]) rejects(() => encodeVerificationResponse(challenge), 'INVALID_CHALLENGE');
  rejects(() => validateVerificationResponse({ ...echoInput(), rawBody: Buffer.from([0xff]) }), 'INVALID_UTF8');
  rejects(() => validateVerificationResponse({ ...echoInput(), rawBody: Buffer.from('{') }), 'INVALID_JSON');
});

test('signatures verify original whitespace, Unicode and exact raw bytes', () => {
  const rawBody = Buffer.from(JSON.stringify(fixture(), null, 2) + '\n');
  const headers = independentlySigned(rawBody);
  assert.deepEqual(decodeOwnerEventRequest({ method: 'POST', secret: SECRET, headers, rawBody, nowSeconds: NOW, expectedSubscriptionId: SUB }), fixture());
  rejects(() => verifyRawBody({ secret: SECRET, headers, rawBody: Buffer.from(JSON.stringify(fixture())), nowSeconds: NOW, expectedSubscriptionId: SUB }), 'SIGNATURE_MISMATCH');
  rejects(() => verifyRawBody({ secret: SECRET, headers, rawBody: Buffer.concat([rawBody, Buffer.from(' ')]), nowSeconds: NOW, expectedSubscriptionId: SUB }), 'SIGNATURE_MISMATCH');
  rejects(() => signRawBody({ secret: SECRET, webhookId: 'evt_synthetic_only', signingTimestamp: NOW, rawBody: rawBody.toString() }), 'RAW_BYTES_REQUIRED');
});

test('wrong key and altered event identifier cannot verify', () => {
  const request = encodeEvent(fixture());
  rejects(() => verifyRawBody({ ...verification(request), secret: OTHER_SECRET }), 'SIGNATURE_MISMATCH');
  rejects(() => verifyRawBody({ ...verification(request), headers: { ...request.headers, 'webhook-id': 'evt_other_synthetic' } }), 'SIGNATURE_MISMATCH');
});

test('space-separated HMAC signatures support a caller-owned rotation window', () => {
  const request = encodeEvent(fixture());
  const other = signRawBody({ secret: OTHER_SECRET, webhookId: 'evt_synthetic_only', signingTimestamp: NOW, rawBody: Buffer.from(request.body) });
  const headers = { ...request.headers, 'webhook-signature': `${other} ${request.headers['webhook-signature']}` };
  verifyRawBody({ ...verification(request), headers });
  verifyRawBody({ ...verification(request), headers, secret: OTHER_SECRET });
});

test('timestamp freshness boundaries reject past and future outside 300 seconds', () => {
  const request = encodeEvent(fixture());
  for (const delta of [-300, 300]) verifyRawBody({ ...verification(request), nowSeconds: NOW + delta });
  for (const delta of [-301, 301]) rejects(() => verifyRawBody({ ...verification(request), nowSeconds: NOW + delta }), 'STALE_SIGNATURE');
  rejects(() => verifyRawBody({ ...verification(request), toleranceSeconds: 301 }), 'INVALID_FRESHNESS_POLICY');
  for (const timestamp of ['01', '-1', '1.0', '+1', '1e9', '9007199254740992', '1.2', '']) rejects(() => normalizeWireHeaders({ ...request.headers, 'webhook-timestamp': timestamp }), timestamp === '' ? 'INVALID_HEADERS' : 'INVALID_SIGNING_TIMESTAMP');
});

test('header lookup is case-insensitive and duplicates fail closed', () => {
  const request = encodeEvent(fixture());
  const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toUpperCase(), value]));
  verifyRawBody({ ...verification(request), headers });
  rejects(() => normalizeWireHeaders({ ...request.headers, 'WEBHOOK-ID': 'evt_other' }), 'DUPLICATE_HEADER');
  for (const value of [[], ['a', 'b'], '\r\nspoof:yes', 123]) rejects(() => normalizeWireHeaders({ ...request.headers, 'webhook-id': value }), 'INVALID_HEADERS');
  const missing = { ...request.headers };
  delete missing['webhook-id'];
  rejects(() => normalizeWireHeaders(missing), 'MISSING_HEADER');
});

test('unsupported signature versions and malformed encodings are rejected by local HMAC profile', () => {
  const request = encodeEvent(fixture());
  for (const signature of ['v1,abc', 'v2,' + 'A'.repeat(43) + '=', 'v1,' + 'A'.repeat(43) + '=', request.headers['webhook-signature'] + ' ', ' ' + request.headers['webhook-signature'], Array(9).fill(request.headers['webhook-signature']).join(' ')]) {
    const headers = { ...request.headers, 'webhook-signature': signature };
    if (signature === 'v1,' + 'A'.repeat(43) + '=') rejects(() => verifyRawBody({ ...verification(request), headers }), 'SIGNATURE_MISMATCH');
    else rejects(() => normalizeWireHeaders(headers), 'INVALID_SIGNATURE_HEADER');
  }
});

test('POST and content type are required by the local wire profile', () => {
  const request = encodeEvent(fixture());
  rejects(() => decodeOwnerEventRequest({ method: 'GET', ...verification(request) }), 'INVALID_METHOD');
  rejects(() => decodeVerificationRequest({ method: 'GET', ...verification(encodeChallenge()) }), 'INVALID_METHOD');
  rejects(() => normalizeWireHeaders({ ...request.headers, 'Content-Type': 'text/plain' }), 'INVALID_CONTENT_TYPE');
});

test('body limits are measured as byte length at the exact inclusive boundary', () => {
  const input = { secret: SECRET, webhookId: 'evt_synthetic_only', signingTimestamp: NOW };
  assert.equal(typeof signRawBody({ ...input, rawBody: Buffer.alloc(MAX_BODY_BYTES, 0x61) }), 'string');
  for (const rawBody of [Buffer.alloc(0), Buffer.alloc(MAX_BODY_BYTES + 1)]) rejects(() => signRawBody({ ...input, rawBody }), 'INVALID_BODY_SIZE');
});

test('event rejects invalid shape, protocol controls and unknown application fields', () => {
  for (const event of [null, [], { ...fixture(), extra: 'synthetic' }, { ...fixture(), type: 'verification' }, { ...fixture(), name: 'other.synthetic' }, { ...fixture(), cursor: 'unsupported_synthetic' }]) rejects(() => validateOwnerEvent(event), 'INVALID_EVENT');
  for (const data of [{ ...fixture().data, extra: true }, { ...fixture().data, generation: 0 }, { ...fixture().data, generation: 1.2 }, { ...fixture().data, request_id: 'bad id' }]) rejects(() => validateOwnerEvent({ ...fixture(), data }), 'INVALID_EVENT_DATA');
});

test('event correlation rejects mismatched body, header, subscription and binding', () => {
  rejects(() => validateOwnerEvent({ ...fixture(), eventId: 'evt_other_synthetic' }), 'EVENT_ID_MISMATCH');
  rejects(() => encodeEvent({ ...fixture(), data: { ...fixture().data, subscription_id: 'sub_other_synthetic' } }), 'SUBSCRIPTION_MISMATCH');
  rejects(() => validateOwnerEvent(fixture(), { expectedBindingId: 'binding_other_synthetic' }), 'BINDING_MISMATCH');
  rejects(() => validateOwnerEvent(fixture(), { expectedGeneration: 2 }), 'GENERATION_MISMATCH');
  const request = encodeEvent(fixture());
  rejects(() => verifyRawBody({ ...verification(request), expectedSubscriptionId: 'sub_other_synthetic' }), 'SUBSCRIPTION_MISMATCH');
  const rawBody = Buffer.from(JSON.stringify(fixture()));
  rejects(() => decodeOwnerEventRequest({ method: 'POST', secret: SECRET, headers: independentlySigned(rawBody, 'evt_other_synthetic'), rawBody, nowSeconds: NOW, expectedSubscriptionId: SUB }), 'EVENT_ID_MISMATCH');
});

test('event timestamps require a valid calendar date and explicit timezone', () => {
  for (const timestamp of ['2026-10-01T01:00:00+01:00', '2024-02-29T00:00:00.123456Z']) validateOwnerEvent({ ...fixture(), timestamp });
  for (const timestamp of ['2026-10-01T00:00:00', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T00:00:60Z', 'not-a-date']) rejects(() => validateOwnerEvent({ ...fixture(), timestamp }), 'INVALID_EVENT_TIMESTAMP');
});

test('event text rejects malformed Unicode, controls, empty and over-bound text', () => {
  for (const text of ['', '  ', '\ud800', 'synthetic\u0000', 'x'.repeat(4001)]) rejects(() => validateOwnerEvent({ ...fixture(), data: { ...fixture().data, text } }), 'INVALID_EVENT_TEXT');
  validateOwnerEvent({ ...fixture(), data: { ...fixture().data, text: '合成\n文本\tfixture' } });
});

test('authenticated but invalid UTF8 and JSON bodies fail decoding', () => {
  for (const [rawBody, code] of [[Buffer.from([0xff]), 'INVALID_UTF8'], [Buffer.from('{'), 'INVALID_JSON'], [Buffer.from('null'), 'INVALID_EVENT']]) rejects(() => decodeOwnerEventRequest({ method: 'POST', secret: SECRET, headers: independentlySigned(rawBody), rawBody, nowSeconds: NOW, expectedSubscriptionId: SUB }), code);
});

test('signed verification body requires exact protocol fields', () => {
  for (const value of [{ type: 'event', challenge: CHALLENGE }, { type: 'verification', challenge: CHALLENGE, data: {} }, { type: 'verification', challenge: '' }]) {
    const rawBody = Buffer.from(JSON.stringify(value));
    rejects(() => decodeVerificationRequest({ method: 'POST', secret: SECRET, headers: independentlySigned(rawBody, 'msg_synthetic_verify'), rawBody, nowSeconds: NOW, expectedSubscriptionId: SUB }), 'INVALID_VERIFICATION_BODY');
  }
});

test('accessors and symbol fields are rejected without evaluating accessors', () => {
  let touched = false;
  const event = fixture();
  Object.defineProperty(event, 'name', { enumerable: true, get() { touched = true; return 'weixin.owner_message'; } });
  rejects(() => validateOwnerEvent(event), 'INVALID_EVENT');
  assert.equal(touched, false);
  const symbols = fixture();
  symbols[Symbol('synthetic')] = true;
  rejects(() => validateOwnerEvent(symbols), 'INVALID_EVENT');
  const hidden = fixture();
  Object.defineProperty(hidden, 'name', { enumerable: false, value: 'weixin.owner_message' });
  rejects(() => validateOwnerEvent(hidden), 'INVALID_EVENT');
});

test('message IDs cannot contain signed-prefix delimiters or header injection', () => {
  for (const webhookId of ['id.with.dot', 'id\nheader', '合成标识', '']) rejects(() => buildVerificationRequest({ challenge: CHALLENGE, callbackUrl: CALLBACK, secret: SECRET, webhookId, subscriptionId: SUB, signingTimestamp: NOW }), 'INVALID_WEBHOOK_ID');
});

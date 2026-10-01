import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildVerificationRequest, validateVerificationResponse, buildSignedEventRequest, validateOwnerEvent } from './event-wire.mjs';

const fields = ['tenantId', 'subject', 'grantId', 'bindingId', 'watchId', 'generation', 'revision'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw new InjectedEventDeliveryError(code); };
const demand = (condition, code) => { if (!condition) fail(code); };

export class InjectedEventDeliveryError extends Error {
  constructor(code) { super(code); this.code = code; this.retryAutomatically = false; }
}

export function createInjectedEventDelivery({ transport, clock = Date.now, timeoutMs = 10000 } = {}) {
  demand(typeof transport === 'function' && typeof clock === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000, 'INJECTED_TRANSPORT_REQUIRED');
  const verified = new Map(), controllers = new Map();
  let closed = false, highWater = -1;
  const now = () => {
    const value = clock();
    demand(natural(value) && value >= highWater, 'INVALID_CLOCK');
    highWater = value;
    return value;
  };
  const keyFor = sub => {
    const keys = ['subscriptionId', 'principal', 'authorizationExpiresAtMs', 'expiresAtMs', 'delivery'];
    demand((exact(sub, keys) || exact(sub, [...keys, 'active']) && sub.active === true) && id(sub.subscriptionId) && exact(sub.principal, fields) && fields.every(key => ['generation', 'revision'].includes(key) ? natural(sub.principal[key]) && sub.principal[key] > 0 : id(sub.principal[key])), 'INVALID_SUBSCRIPTION');
    demand(natural(sub.expiresAtMs) && natural(sub.authorizationExpiresAtMs) && sub.expiresAtMs <= sub.authorizationExpiresAtMs && sub.expiresAtMs > now(), 'SUBSCRIPTION_EXPIRED');
    demand(exact(sub.delivery, ['mode', 'url', 'secret']) && sub.delivery.mode === 'webhook', 'INVALID_DELIVERY');
    return createHash('sha256').update(JSON.stringify([sub.subscriptionId, fields.map(key => sub.principal[key]), sub.delivery.url, sub.delivery.secret, sub.expiresAtMs, sub.authorizationExpiresAtMs])).digest('hex');
  };
  const ready = signal => { demand(!closed, 'DELIVERY_CLOSED'); demand(!signal?.aborted, 'OPERATION_CANCELLED'); };
  const request = async (wire, signal) => {
    ready(signal);
    const controller = new AbortController();
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      const cancel = code => { reject(new InjectedEventDeliveryError(code)); controller.abort(); };
      controllers.set(controller, cancel);
      abort = () => cancel('OPERATION_CANCELLED');
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => cancel('TRANSPORT_TIMEOUT'), timeoutMs);
    });
    try {
      const response = await Promise.race([Promise.resolve().then(() => { ready(controller.signal); return transport(wire, { signal: controller.signal }); }), interrupted]);
      ready(signal);
      demand(exact(response, ['status', 'rawBody']) && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 && (Buffer.isBuffer(response.rawBody) || response.rawBody instanceof Uint8Array) && response.rawBody.byteLength <= 262144, 'INVALID_TRANSPORT_RESPONSE');
      return response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
      controllers.delete(controller);
    }
  };
  return Object.freeze({
    status: () => Object.freeze({ evidenceMode: 'LOCAL_INJECTED_TRANSPORT', liveEnabled: false, existingDot: 'not_verified', automaticRetry: false, closed }),
    async verifySubscription(input, { signal } = {}) {
      ready(signal);
      const sub = structuredClone(input), key = keyFor(sub), time = now();
      for (const [entry, expiry] of verified) if (expiry <= time) verified.delete(entry);
      if (verified.has(key)) return Object.freeze({ verified: true });
      demand(verified.size < 256, 'VERIFICATION_CAPACITY');
      const challenge = randomBytes(32).toString('base64url');
      const issuedAtSeconds = Math.floor(time / 1000);
      const expiresAtSeconds = issuedAtSeconds + Math.ceil(timeoutMs / 1000);
      const wire = buildVerificationRequest({ challenge, callbackUrl: sub.delivery.url, secret: sub.delivery.secret, webhookId: `verification-${randomUUID()}`, subscriptionId: sub.subscriptionId, signingTimestamp: issuedAtSeconds });
      try {
        const response = await request(wire, signal);
        ready(signal);
        const checked = validateVerificationResponse({ ...response, expectedChallenge: challenge, issuedAtSeconds, expiresAtSeconds, nowSeconds: Math.floor(now() / 1000), consumed: false });
        keyFor(sub);
        ready(signal);
        verified.set(key, sub.expiresAtMs);
        return Object.freeze({ verified: checked.verified });
      } catch (error) {
        if (error instanceof InjectedEventDeliveryError && ['OPERATION_CANCELLED', 'DELIVERY_CLOSED', 'INVALID_CLOCK'].includes(error.code)) throw error;
        return Object.freeze({ verified: false });
      }
    },
    async publishEvent(event, input, { signal } = {}) {
      ready(signal);
      const sub = structuredClone(input), key = keyFor(sub);
      demand(verified.has(key) && verified.get(key) > now(), 'CALLBACK_NOT_VERIFIED');
      validateOwnerEvent(event, { expectedSubscriptionId: sub.subscriptionId, expectedBindingId: sub.principal.bindingId, expectedGeneration: sub.principal.generation });
      const wire = buildSignedEventRequest({ event, callbackUrl: sub.delivery.url, secret: sub.delivery.secret, subscriptionId: sub.subscriptionId, signingTimestamp: Math.floor(now() / 1000) });
      try {
        const response = await request(wire, signal);
        ready(signal);
        keyFor(sub);
        ready(signal);
        return Object.freeze({ outcome: response.status >= 200 && response.status <= 299 ? 'ACCEPTED' : response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) ? 'REJECTED' : 'OUTCOME_UNKNOWN' });
      } catch { return Object.freeze({ outcome: 'OUTCOME_UNKNOWN' }); }
    },
    close() { closed = true; verified.clear(); for (const cancel of controllers.values()) cancel('DELIVERY_CLOSED'); },
  });
}

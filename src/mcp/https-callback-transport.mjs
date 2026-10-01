import { isIP } from 'node:net';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { checkServerIdentity } from 'node:tls';

export const MAX_CALLBACK_BODY_BYTES = 262144;
export const MAX_CALLBACK_RESPONSE_BYTES = 262144;
const HEADER_NAMES = ['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id'];
const DENIED_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const ipv4Number = address => address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
const deniedRanges = DENIED_IPV4.map(([address, prefix]) => [ipv4Number(address), 2 ** (32 - prefix)]);
const fail = code => { throw new HttpsCallbackTransportError(code); };
const demand = (value, code) => { if (!value) fail(code); };

export class HttpsCallbackTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HttpsCallbackTransportError';
    this.code = code;
    this.retryAutomatically = false;
  }
}

export function isPublicCallbackIPv4(address) {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const value = ipv4Number(address);
  return !deniedRanges.some(([base, width]) => value >= base && value < base + width);
}

function snapshotRequest(wire, isTrustedHostname) {
  demand(wire && wire.method === 'POST' && wire.redirect === 'error', 'INVALID_CALLBACK_REQUEST');
  demand(typeof wire.url === 'string' && wire.url.length <= 2048 && /^https:\/\//iu.test(wire.url) && !/[\u0000-\u0020\u007f\\#]/u.test(wire.url), 'INVALID_CALLBACK_URL');
  let url;
  try { url = new URL(wire.url); } catch { fail('INVALID_CALLBACK_URL'); }
  demand(url.protocol === 'https:' && url.href.length <= 2048 && !url.username && !url.password && url.hostname && (!url.port || url.port === '443'), 'INVALID_CALLBACK_URL');
  demand(!isIP(url.hostname) && !url.hostname.includes(':') && !url.hostname.includes('['), 'IP_LITERAL_UNSUPPORTED');
  demand(url.hostname.length <= 253 && url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) && url.hostname.includes('.'), 'INVALID_CALLBACK_HOSTNAME');
  let trusted = false;
  try { trusted = isTrustedHostname(url.hostname) === true; } catch { fail('UNTRUSTED_CALLBACK_HOSTNAME'); }
  demand(trusted, 'UNTRUSTED_CALLBACK_HOSTNAME');
  let body;
  if (typeof wire.body === 'string') {
    demand(Buffer.byteLength(wire.body, 'utf8') <= MAX_CALLBACK_BODY_BYTES, 'CALLBACK_BODY_TOO_LARGE');
    body = Buffer.from(wire.body, 'utf8');
    demand(body.toString('utf8') === wire.body, 'INVALID_CALLBACK_BODY');
  } else {
    demand(wire.body instanceof Uint8Array, 'INVALID_CALLBACK_BODY');
    demand(wire.body.byteLength <= MAX_CALLBACK_BODY_BYTES, 'CALLBACK_BODY_TOO_LARGE');
    body = Buffer.from(wire.body);
  }
  demand(body.byteLength > 0, 'INVALID_CALLBACK_BODY');
  demand(wire.headers && typeof wire.headers === 'object' && !Array.isArray(wire.headers) && [Object.prototype, null].includes(Object.getPrototypeOf(wire.headers)), 'INVALID_CALLBACK_HEADERS');
  const headers = Object.create(null);
  for (const name of Reflect.ownKeys(wire.headers)) {
    demand(typeof name === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(wire.headers, name), 'value'), 'INVALID_CALLBACK_HEADERS');
    const lower = name.toLowerCase(), value = wire.headers[name];
    demand(HEADER_NAMES.includes(lower) && !Object.hasOwn(headers, lower) && typeof value === 'string' && value.length > 0 && value.length <= 4096, 'INVALID_CALLBACK_HEADERS');
    try { validateHeaderName(name); validateHeaderValue(name, value); } catch { fail('INVALID_CALLBACK_HEADERS'); }
    headers[lower] = value;
  }
  demand(HEADER_NAMES.every(name => Object.hasOwn(headers, name)) && headers['content-type'] === 'application/json', 'INVALID_CALLBACK_HEADERS');
  headers.host = url.hostname;
  headers['content-length'] = String(body.byteLength);
  headers.connection = 'close';
  return { hostname: url.hostname, path: `${url.pathname}${url.search}`, headers, body };
}

export function createHttpsCallbackTransport({ isTrustedHostname, resolve, request, timeoutMs = 10000 } = {}) {
  demand(typeof isTrustedHostname === 'function' && typeof resolve === 'function' && typeof request === 'function', 'EXPLICIT_HTTPS_DEPENDENCIES_REQUIRED');
  demand(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000, 'INVALID_CALLBACK_DEADLINE');
  return async function transport(wire, { signal } = {}) {
    demand(signal === undefined || signal instanceof AbortSignal, 'INVALID_ABORT_SIGNAL');
    demand(!signal?.aborted, 'OPERATION_CANCELLED');
    let snapshot;
    try { snapshot = snapshotRequest(wire, isTrustedHostname); } catch (error) {
      if (error instanceof HttpsCallbackTransportError) throw error;
      fail('INVALID_CALLBACK_REQUEST');
    }
    return new Promise((resolveResult, rejectResult) => {
      let settled = false, req, response, timer;
      const controller = new AbortController();
      const chunks = [];
      let total = 0;
      const finish = (code, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (code) {
          controller.abort();
          response?.destroy();
          req?.destroy();
          rejectResult(new HttpsCallbackTransportError(code));
        } else resolveResult(result);
      };
      const abort = () => finish('OPERATION_CANCELLED');
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish('CALLBACK_TIMEOUT'), timeoutMs);
      if (signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => {
        if (settled) return;
        return resolve(snapshot.hostname, { all: true, family: 4, verbatim: true, signal: controller.signal });
      }).then(addresses => {
        if (settled) return;
        if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 32) { finish('INVALID_DNS_RESULT'); return; }
        if (addresses.some(entry => !entry || entry.family !== 4 || !isPublicCallbackIPv4(entry.address))) { finish('NON_PUBLIC_OR_UNSUPPORTED_ADDRESS'); return; }
        const address = addresses[0].address;
        const options = {
          protocol: 'https:', hostname: address, family: 4, port: 443,
          servername: snapshot.hostname, rejectUnauthorized: true,
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(snapshot.hostname, certificate),
          lookup: (_hostname, lookupOptions, callback) => lookupOptions?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
          agent: false, method: 'POST', path: snapshot.path, headers: snapshot.headers, signal: controller.signal,
          maxHeaderSize: 16384, insecureHTTPParser: false,
        };
        try {
          req = request(options, incoming => {
            if (settled) { incoming.destroy(); return; }
            response = incoming;
            response.on('error', () => finish('CALLBACK_RESPONSE_ERROR'));
            response.on('aborted', () => finish('CALLBACK_RESPONSE_INCOMPLETE'));
            response.on('close', () => { if (!settled) finish('CALLBACK_RESPONSE_INCOMPLETE'); });
            const status = response.statusCode;
            if (!Number.isInteger(status) || status < 100 || status > 599) { finish('INVALID_CALLBACK_RESPONSE'); return; }
            if (status >= 300 && status <= 399) { finish('CALLBACK_REDIRECT_BLOCKED'); return; }
            const length = response.headers?.['content-length'];
            if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(length) || !Number.isSafeInteger(Number(length)))) { finish('INVALID_CALLBACK_RESPONSE'); return; }
            if (length !== undefined && Number(length) > MAX_CALLBACK_RESPONSE_BYTES) { finish('CALLBACK_RESPONSE_TOO_LARGE'); return; }
            response.on('data', chunk => {
              if (settled) return;
              if (!(chunk instanceof Uint8Array)) { finish('INVALID_CALLBACK_RESPONSE'); return; }
              total += chunk.byteLength;
              if (total > MAX_CALLBACK_RESPONSE_BYTES) { finish('CALLBACK_RESPONSE_TOO_LARGE'); return; }
              chunks.push(Buffer.from(chunk));
            });
            response.on('end', () => {
              if (length !== undefined && total !== Number(length) || response.complete === false) { finish('CALLBACK_RESPONSE_INCOMPLETE'); return; }
              finish(null, { status, rawBody: Buffer.concat(chunks, total) });
            });
          });
          req.on('error', () => finish('CALLBACK_REQUEST_ERROR'));
          if (settled) { req.destroy(); return; }
          req.end(snapshot.body);
        } catch { finish('CALLBACK_REQUEST_ERROR'); }
      }, () => finish('CALLBACK_DNS_ERROR')).catch(() => finish('CALLBACK_REQUEST_ERROR'));
    });
  };
}

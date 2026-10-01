import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer, ProtocolError, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createLoopbackBackend, LoopbackBackendError, loopbackOperationSchemas } from './backend.mjs';
import { createOAuthHttpGate, PROTECTED_RESOURCE_PATHS } from './oauth-http.mjs';

export const PROTOCOL_VERSION = '2026-07-28';
export const DEFAULT_LIMITS = Object.freeze({ bodyBytes: 32768, headerBytes: 16384, headerMs: 5000, bodyMs: 10000, callMs: 15000, listenMs: 60000, concurrent: 16, subscriptions: 4 });
const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const anyObject = fromJsonSchema({ type: 'object', additionalProperties: true });
const emptyParams = fromJsonSchema(objectSchema({ cursor: { type: 'string', maxLength: 512 } }));
const cache = { ttlMs: 0, cacheScope: 'private' };
const safeBackendError = error => error instanceof LoopbackBackendError && /^[A-Z_]{1,80}$/u.test(error.code) ? error.code : 'BACKEND_REQUEST_REJECTED';
const failureDetails = error => ({ code: safeBackendError(error), outcome: error instanceof LoopbackBackendError && ['NOT_STARTED', 'OUTCOME_UNKNOWN'].includes(error.outcome) ? error.outcome : 'OUTCOME_UNKNOWN', retryAutomatically: false, liveEnabled: false });
const requirePositive = (value, name) => { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_${name}`); return value; };
const acceptsBoth = value => {
  if (typeof value !== 'string') return false;
  const accepted = new Map();
  for (const part of value.toLowerCase().split(',')) {
    const [type, ...parameters] = part.trim().split(';').map(item => item.trim());
    let quality = 1, hasQuality = false;
    for (const parameter of parameters) {
      if (!parameter.startsWith('q=')) continue;
      if (hasQuality || !/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(parameter)) return false;
      hasQuality = true; quality = Number(parameter.slice(2));
    }
    accepted.set(type, Math.min(accepted.get(type) ?? 1, quality));
  }
  return ['application/json', 'text/event-stream'].every(type => accepted.has(type) && accepted.get(type) > 0);
};

export async function startLocalMcpService(options = {}) {
  if (Object.keys(options).some(key => !['port', 'backend', 'resolveContext', 'limits', 'durationMs', 'oauth'].includes(key))) throw new Error('UNSUPPORTED_SERVICE_OPTION');
  if (options.oauth !== undefined && Object.hasOwn(options, 'resolveContext')) throw new Error('OAUTH_CONTEXT_RESOLVER_CONFLICT');
  const oauth = options.oauth === undefined ? undefined : createOAuthHttpGate(options.oauth);
  const authenticatedRequests = new AsyncLocalStorage();
  const { port = 8890, backend = createLoopbackBackend(), resolveContext = async () => undefined } = options;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  if (typeof resolveContext !== 'function') throw new Error('INVALID_CONTEXT_RESOLVER');
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new Error('UNSUPPORTED_LIMIT');
    requirePositive(value, 'LIMIT');
    if (value > DEFAULT_LIMITS[key]) throw new Error('LIMIT_EXCEEDS_SAFE_DEFAULT');
  }
  if (options.durationMs !== undefined) requirePositive(options.durationMs, 'DURATION');
  let inFlight = 0, rejected = 0, closed = false, closePromise, lifetimeTimer;
  const sockets = new Set();
  const safeCall = async operation => {
    try { return await operation(); }
    catch (error) { throw new ProtocolError(error instanceof LoopbackBackendError && error.code === 'CALLBACK_NOT_VERIFIED' ? -32015 : -32001, safeBackendError(error), failureDetails(error)); }
  };
  const handler = createMcpHandler(async ({ requestInfo }) => {
    let context;
    try {
      if (oauth) {
        const authenticated = authenticatedRequests.getStore();
        if (!authenticated || authenticated.signal.aborted) throw new Error('HTTP_AUTHENTICATION_REQUIRED');
        context = authenticated.context;
      } else context = await resolveContext(requestInfo);
    }
    catch { throw new ProtocolError(-32001, 'AUTHORIZATION_REJECTED'); }
    const server = new McpServer({ name: 'dots-wechat-local', version: '0.0.1' }, { capabilities: { events: {}, resources: { listChanged: true, subscribe: false } } });
    for (const tool of backend.catalog.tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema), ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema) } : {}), annotations: tool.annotations }, async (args, ctx) => {
        try {
          const value = await backend.callTool(tool.name, args, context, { signal: ctx.mcpReq.signal });
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...cache };
        } catch (error) {
          const value = failureDetails(error);
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...cache };
        }
      });
    }
    server.server.setRequestHandler('resources/list', async () => ({ resources: backend.catalog.resources, ...cache }));
    server.server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: backend.catalog.resourceTemplates, ...cache }));
    server.server.setRequestHandler('resources/read', async (request, ctx) => {
      const value = await safeCall(() => backend.readResource(request.params.uri, context, { signal: ctx.mcpReq.signal }));
      return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(value) }], ...cache };
    });
    server.server.setRequestHandler('events/list', { params: emptyParams, result: anyObject }, async () => ({ ...await backend.listEvents(), ...cache }));
    server.server.setRequestHandler('events/subscribe', { params: fromJsonSchema(loopbackOperationSchemas.subscribe), result: anyObject }, async (params, ctx) => safeCall(async () => {
      const value = await backend.subscribe(params, context, { signal: ctx.mcpReq.signal });
      return { id: value.subscriptionId, refreshBefore: new Date(value.expiresAtMs).toISOString(), cursor: null, truncated: false };
    }));
    server.server.setRequestHandler('events/unsubscribe', { params: fromJsonSchema(loopbackOperationSchemas.unsubscribe), result: anyObject }, async (params, ctx) => safeCall(async () => {
      await backend.unsubscribe(params, context, { signal: ctx.mcpReq.signal });
      return {};
    }));
    return server;
  }, { legacy: 'reject', responseMode: 'auto', maxRequestBodySize: limits.bodyBytes, maxSubscriptions: limits.subscriptions, keepAliveMs: Math.min(15000, limits.listenMs), onerror: () => { rejected += 1; } });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: limits.bodyBytes, onerror: () => { rejected += 1; } });
  const respond = (res, status, code) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify({ code }));
  };
  const http = createServer({ maxHeaderSize: limits.headerBytes, headersTimeout: limits.headerMs, requestTimeout: limits.bodyMs, connectionsCheckingInterval: Math.min(limits.headerMs, 1000), keepAliveTimeout: 1000 }, async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.rawHeaders.length > 96) return respond(res, 431, 'TOO_MANY_HEADERS');
    const rawCounts = new Map();
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const key = req.rawHeaders[index].toLowerCase();
      rawCounts.set(key, (rawCounts.get(key) ?? 0) + 1);
    }
    if ([...rawCounts].some(([key, count]) => count > 1 && ['host', 'origin', 'authorization', 'content-length', 'content-type', 'transfer-encoding', 'mcp-protocol-version', 'mcp-method', 'mcp-name'].includes(key))) return respond(res, 400, 'DUPLICATE_HEADER');
    const currentPort = http.address()?.port;
    if (![ `127.0.0.1:${currentPort}`, `localhost:${currentPort}` ].includes(req.headers.host)) return respond(res, 403, 'HOST_REJECTED');
    if (req.headers.origin !== undefined) return respond(res, 403, 'ORIGIN_REJECTED');
    if (Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'))) return respond(res, 400, 'FORWARDED_HEADERS_REJECTED');
    if (closed) return respond(res, 503, 'SERVICE_CLOSING');
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ service: 'dots-wechat-local', transport: 'LOOPBACK_HTTP', protocolVersion: PROTOCOL_VERSION, liveEnabled: false, ...backend.status() }));
    }
    if (oauth && PROTECTED_RESOURCE_PATHS.includes(req.url)) {
      if (req.method !== 'GET') { res.setHeader('allow', 'GET'); return respond(res, 405, 'METHOD_NOT_ALLOWED'); }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(oauth.metadata) });
      return res.end(oauth.metadata);
    }
    if (req.url !== '/mcp') return respond(res, 404, 'NOT_FOUND');
    if (inFlight >= limits.concurrent) return respond(res, 503, 'CONCURRENCY_LIMIT');
    inFlight += 1;
    let finished = false;
    const authenticationAbort = new AbortController();
    const complete = () => {
      if (finished) return;
      finished = true; inFlight -= 1;
      authenticationAbort.abort();
      clearTimeout(bodyTimer); clearTimeout(callTimer);
    };
    const bodyTimer = setTimeout(() => { respond(res, 408, 'BODY_TIMEOUT'); req.destroy(); }, limits.bodyMs);
    const callTimer = setTimeout(() => { respond(res, 504, 'REQUEST_DEADLINE'); res.destroy(); }, req.headers['mcp-method'] === 'subscriptions/listen' ? limits.listenMs : limits.callMs);
    bodyTimer.unref(); callTimer.unref();
    req.once('end', () => clearTimeout(bodyTimer));
    res.once('close', complete); res.once('finish', complete);
    try {
      let authenticated;
      if (oauth) {
        authenticated = await oauth.verify(req, authenticationAbort.signal);
        if (finished || res.destroyed || res.writableEnded) return;
        if (!authenticated) {
          res.setHeader('www-authenticate', oauth.challenge);
          return respond(res, 401, 'HTTP_AUTHENTICATION_REQUIRED');
        }
      }
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return respond(res, 405, 'METHOD_NOT_ALLOWED'); }
      if (!acceptsBoth(req.headers.accept)) return respond(res, 406, 'ACCEPT_JSON_AND_SSE_REQUIRED');
      if (req.headers['content-encoding'] !== undefined) return respond(res, 415, 'CONTENT_ENCODING_REJECTED');
      if (req.headers['mcp-session-id'] !== undefined || req.headers['last-event-id'] !== undefined) return respond(res, 400, 'LEGACY_SESSION_REPLAY_UNSUPPORTED');
      if (oauth) await authenticatedRequests.run(Object.freeze({ ...authenticated, signal: authenticationAbort.signal }), () => nodeHandler(req, res));
      else await nodeHandler(req, res);
    }
    catch { rejected += 1; respond(res, 500, 'TRANSPORT_FAILURE'); if (!res.writableEnded) res.destroy(); }
  });
  http.maxHeadersCount = 0;
  http.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  http.on('clientError', (_error, socket) => { rejected += 1; if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen({ host: '127.0.0.1', port, exclusive: true }, () => { http.off('error', reject); resolve(); });
  });
  const address = Object.freeze({ host: '127.0.0.1', port: http.address().port, url: `http://127.0.0.1:${http.address().port}/mcp` });
  const close = () => closePromise ??= (async () => {
    closed = true; clearTimeout(lifetimeTimer);
    const stopped = new Promise(resolve => http.close(resolve));
    for (const socket of sockets) socket.destroy();
    await handler.close();
    await stopped;
    let timer;
    await Promise.race([backend.close(), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
  })();
  if (options.durationMs !== undefined) lifetimeTimer = setTimeout(() => { void close(); }, options.durationMs);
  return Object.freeze({ address, close, status: () => ({ closed, inFlight, rejected, subscriptions: handler.bus.listenerCount, ...backend.status() }), notifyCatalogChanged: () => { handler.notify.toolsChanged(); handler.notify.resourcesChanged(); } });
}

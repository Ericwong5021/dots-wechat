import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export const PROTECTED_RESOURCE_PATHS = Object.freeze(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
const demand = (value, code) => { if (!value) throw new Error(code); };
const exact = (value, fields, required = fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.includes(key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable) && required.every(key => Object.hasOwn(descriptors, key));
};
const externalUrl = (value, code) => {
  demand(typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u0020\u007f"\\]/u.test(value), code);
  let url;
  try { url = new URL(value); } catch { throw new Error(code); }
  demand(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === value, code);
  demand(!isIP(url.hostname) && !url.hostname.startsWith('[') && url.hostname.includes('.') && /^[a-z0-9.-]+$/u.test(url.hostname) && !url.hostname.endsWith('.') && !/(?:^|\.)(?:localhost|local|internal)$/u.test(url.hostname), code);
  return url;
};

export function createOAuthHttpGate(options) {
  demand(exact(options, ['resourceUrl', 'issuer', 'scopes', 'authenticate'], ['resourceUrl', 'issuer', 'authenticate']), 'INVALID_OAUTH_HTTP_CONFIGURATION');
  demand(typeof options.authenticate === 'function', 'EXTERNAL_AUTHENTICATOR_REQUIRED');
  const resource = externalUrl(options.resourceUrl, 'INVALID_OAUTH_RESOURCE_URL');
  demand(resource.pathname === '/mcp', 'OAUTH_RESOURCE_TARGET_MISMATCH');
  externalUrl(options.issuer, 'INVALID_OAUTH_ISSUER');
  const scopes = options.scopes ?? [];
  demand(Array.isArray(scopes) && scopes.length <= 16 && scopes.every(scope => typeof scope === 'string' && scope.length > 0 && scope.length <= 128 && /^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope)) && new Set(scopes).size === scopes.length, 'INVALID_OAUTH_SCOPES');
  const requiredScopes = Object.freeze([...scopes]);
  const resourceUrl = options.resourceUrl, issuer = options.issuer, authenticate = options.authenticate;
  const boundContexts = new WeakSet();
  const metadataUrl = new URL(PROTECTED_RESOURCE_PATHS[1], resource).href;
  const metadata = JSON.stringify({ resource: resourceUrl, authorization_servers: [issuer], bearer_methods_supported: ['header'], ...(requiredScopes.length ? { scopes_supported: requiredScopes } : {}) });
  demand(Buffer.byteLength(metadata) <= 8192, 'OAUTH_METADATA_TOO_LARGE');
  const challenge = `Bearer resource_metadata="${metadataUrl}"${requiredScopes.length ? `, scope="${requiredScopes.join(' ')}"` : ''}`;
  const verify = async (req, signal) => {
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || authorization.length > 8192 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/iu.test(authorization) || signal.aborted) return undefined;
    const request = Object.freeze({ requestId: randomUUID(), method: req.method, target: '/mcp' });
    try {
      const result = await authenticate(Object.freeze({ bearerToken: authorization.slice(7), request, resourceUrl, issuer, requiredScopes, signal }));
      if (signal.aborted || !exact(result, ['context']) || !result.context || typeof result.context !== 'object' || Array.isArray(result.context) || boundContexts.has(result.context)) return undefined;
      boundContexts.add(result.context);
      return Object.freeze({ request, context: result.context });
    } catch { return undefined; }
  };
  return Object.freeze({ metadata, metadataUrl, challenge, verify });
}

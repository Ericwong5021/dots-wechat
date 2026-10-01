export const PRINCIPAL_FIELDS = Object.freeze(['tenantId', 'subject', 'grantId', 'bindingId', 'watchId', 'generation', 'revision']);
export const MAX_AUTHORIZATION_TTL_MS = 3600000;

export class AuthorizationContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AuthorizationContractError';
    this.code = code;
    this.retryAutomatically = false;
  }
}

const demand = (value, code) => { if (!value) throw new AuthorizationContractError(code); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
const exact = (value, fields, required = fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.includes(key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable) && required.every(key => Object.hasOwn(descriptors, key));
};
const principalValid = value => exact(value, PRINCIPAL_FIELDS) && PRINCIPAL_FIELDS.every(key => ['generation', 'revision'].includes(key) ? integer(value[key]) && value[key] > 0 : id(value[key]));
const principalCopy = value => Object.freeze(Object.fromEntries(PRINCIPAL_FIELDS.map(key => [key, value[key]])));
const same = (a, b) => PRINCIPAL_FIELDS.every(key => a[key] === b[key]);

export function createAuthorizationCheckpoints(options) {
  demand(exact(options, ['verifier', 'expectedPrincipal', 'clock']), 'INVALID_AUTHORIZATION_CONFIGURATION');
  demand(exact(options.verifier, ['authorize']) && typeof options.verifier.authorize === 'function', 'EXTERNAL_VERIFIER_REQUIRED');
  demand(principalValid(options.expectedPrincipal), 'INVALID_EXPECTED_PRINCIPAL');
  demand(typeof options.clock === 'function', 'CLOCK_REQUIRED');
  const expected = principalCopy(options.expectedPrincipal);
  const verifier = options.verifier.authorize.bind(options.verifier);
  const clock = options.clock;
  const issued = new WeakSet();
  let highWater = -1;
  const now = () => {
    const value = clock();
    demand(integer(value) && value >= highWater, 'CLOCK_MOVED_BACKWARDS');
    highWater = value;
    return value;
  };
  const signalCheck = signal => demand(!signal?.aborted, 'OPERATION_CANCELLED');
  const read = async (detail, operationOptions) => {
    demand(exact(detail, ['purpose', 'requestId'], ['purpose']) && id(detail.purpose) && (detail.requestId === undefined || id(detail.requestId)), 'INVALID_AUTHORIZATION_DETAIL');
    demand(exact(operationOptions, ['signal'], []) && (operationOptions.signal === undefined || operationOptions.signal instanceof AbortSignal), 'INVALID_OPERATION_OPTIONS');
    const { signal } = operationOptions;
    signalCheck(signal);
    const request = Object.freeze(Object.fromEntries(Object.keys(detail).map(key => [key, detail[key]])));
    let result;
    try {
      result = await verifier(request);
      demand(exact(result, ['principal', 'expiresAtMs']) && principalValid(result.principal) && integer(result.expiresAtMs), 'AUTHORIZATION_REJECTED');
      result = Object.freeze({ principal: principalCopy(result.principal), expiresAtMs: result.expiresAtMs });
    } catch {
      throw new AuthorizationContractError('AUTHORIZATION_REJECTED');
    }
    signalCheck(signal);
    const time = now();
    demand(result.expiresAtMs > time && result.expiresAtMs - time <= MAX_AUTHORIZATION_TTL_MS, 'AUTHORIZATION_REJECTED');
    return result;
  };
  const authorize = async (detail, operationOptions = {}) => {
    const result = await read(detail, operationOptions);
    demand(same(result.principal, expected), 'PRINCIPAL_BINDING_MISMATCH');
    issued.add(result);
    return result;
  };
  const checkpoint = async (initial, detail, operationOptions = {}) => {
    demand(initial !== null && typeof initial === 'object' && issued.has(initial), 'UNTRUSTED_AUTHORIZATION_SNAPSHOT');
    const result = await read(detail, operationOptions);
    demand(same(result.principal, initial.principal) && result.expiresAtMs === initial.expiresAtMs, 'STALE_AUTHORIZATION');
    issued.add(result);
    return result;
  };
  return Object.freeze({ authorize, checkpoint });
}

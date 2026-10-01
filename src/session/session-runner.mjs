import { mkdtempSync, chmodSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createHardLease } from './hard-lease.mjs';
import { tunnelCommand } from './watchdog.mjs';

const demand = (condition, code) => { if (!condition) throw new Error(code); };
const files = ['runtime-key', 'local-token', 'empty.yaml'];

export function validateEvidence(evidence, expectedTunnelId) {
  demand(evidence?.accountVerified === true && evidence.workspaceVerified === true, 'ACCOUNT_WORKSPACE_EVIDENCE_REQUIRED');
  demand(evidence.tunnelIdentityVerified === true && evidence.privateAccessVerified === true && evidence.newSessionTunnel === true, 'PRIVATE_TUNNEL_EVIDENCE_REQUIRED');
  demand(/^tunnel_[A-Za-z0-9_-]{8,128}$/u.test(evidence.tunnelId ?? '') && (expectedTunnelId === undefined || evidence.tunnelId === expectedTunnelId), 'PRIVATE_TUNNEL_EVIDENCE_REQUIRED');
  demand(evidence.billingKeyProbe === false, 'BILLING_KEY_PROBE_FORBIDDEN');
  demand(evidence.scope === 'health-discovery' && evidence.liveBackendEnabled === false, 'TRUSTED_OWNER_AUTHORIZATION_NOT_INSTALLED');
  return true;
}

export function createPrivateFiles({ askSecret, baseDirectory = tmpdir(), random = randomBytes } = {}) {
  demand(typeof askSecret === 'function', 'SECURE_SECRET_INPUT_NOT_INSTALLED');
  demand(isAbsolute(baseDirectory), 'TEMP_DIRECTORY_INVALID');
  let directory = null, key = null, token = null;
  const cleanup = () => {
    key?.fill(0);
    token?.fill(0);
    if (!directory) return;
    for (const name of files) { try { unlinkSync(join(directory, name)); } catch {} }
    try { rmdirSync(directory); } catch {}
  };
  return Object.freeze({
    cleanup,
    async prepare({ signal } = {}) {
      demand(directory === null, 'PRIVATE_FILES_ONCE');
      try {
        const input = await askSecret({ purpose: 'new-session-runtime-key', echo: false, persist: false, signal });
        demand(Buffer.isBuffer(input), 'SECRET_INPUT_BUFFER_REQUIRED');
        key = input;
        demand(!signal?.aborted, 'SESSION_STOPPED');
        demand(key.length >= 16 && key.length <= 4096 && !key.includes(0) && !key.includes(10) && !key.includes(13), 'RUNTIME_KEY_INVALID');
        token = random(32);
        demand(Buffer.isBuffer(token) && token.length === 32, 'LOCAL_TOKEN_INVALID');
        directory = mkdtempSync(join(baseDirectory, 'dots-wechat-session-'));
        chmodSync(directory, 0o700);
        writeFileSync(join(directory, 'runtime-key'), key, { mode: 0o600, flag: 'wx' });
        writeFileSync(join(directory, 'local-token'), token.toString('hex'), { mode: 0o600, flag: 'wx' });
        writeFileSync(join(directory, 'empty.yaml'), '{}\n', { mode: 0o600, flag: 'wx' });
        key.fill(0);
        token.fill(0);
        return Object.freeze({ directory, localTokenFile: join(directory, 'local-token') });
      } catch (error) { cleanup(); throw new Error(error.message === 'SESSION_STOPPED' ? 'SESSION_STOPPED' : 'PRIVATE_FILES_PREPARATION_FAILED'); }
    },
  });
}

export function createSessionRunner({ evidence, tunnelSpec, askSecret, createWatchdog, startService, baseDirectory, leaseOptions = {}, processEvents, cleanupTimeoutMs = 500 } = {}) {
  const approvedEvidence = Object.freeze({ ...evidence });
  const approvedTunnel = Object.freeze({ ...tunnelSpec });
  let state = 'PREPARED', service = null, guard = null, leaseSnapshot = null, stopPromise = null, stopping = false;
  const abort = new AbortController();
  const privateFiles = createPrivateFiles({ askSecret, baseDirectory });
  const hooks = [];
  const detach = () => { for (const [name, callback] of hooks) processEvents?.off(name, callback); };
  const stop = (reason = 'SESSION_STOP') => {
    if (stopPromise) return stopPromise;
    stopping = true;
    state = 'STOPPED';
    lease.stop();
    abort.abort(reason);
    let guardShutdown;
    try { guardShutdown = guard?.stop(reason); } catch { guardShutdown = undefined; }
    try { service?.disable(); } catch {}
    detach();
    const shutdown = Promise.allSettled([
      Promise.resolve().then(() => service?.close()),
      Promise.resolve(guardShutdown),
    ]);
    stopPromise = new Promise(resolve => {
      const timer = setTimeout(() => { privateFiles.cleanup(); resolve(); }, cleanupTimeoutMs);
      shutdown.then(() => { clearTimeout(timer); privateFiles.cleanup(); resolve(); });
    });
    return stopPromise;
  };
  const lease = createHardLease({ ...leaseOptions, onExpire: reason => { void stop(reason); } });
  const demandActive = () => demand(!stopping && lease.check() && !abort.signal.aborted, 'SESSION_STOPPED');
  if (processEvents) {
    for (const name of ['SIGINT', 'SIGTERM', 'disconnect', 'parentShutdown']) {
      const callback = () => { void stop(name); };
      processEvents.on(name, callback);
      hooks.push([name, callback]);
    }
  }
  return Object.freeze({
    stop,
    snapshot: () => Object.freeze({ state, lease: leaseSnapshot, liveBackendEnabled: false, existingDotVerified: false, headerTokenIsOwnerAuthority: false }),
    async start() {
      demand(state === 'PREPARED' && !stopping, 'SESSION_START_ONCE');
      state = 'PREPARING';
      try {
        validateEvidence(approvedEvidence, approvedTunnel.tunnelId);
        demand(typeof createWatchdog === 'function' && typeof startService === 'function', 'EXECUTION_ADAPTER_NOT_INSTALLED');
        const prepared = await privateFiles.prepare({ signal: abort.signal });
        demand(!stopping, 'SESSION_STOPPED');
        tunnelCommand({ ...approvedTunnel, privateDir: prepared.directory });
        guard = await createWatchdog();
        if (stopping) { await guard.stop('SESSION_STOPPED'); throw new Error('SESSION_STOPPED'); }
        guard.onStopped(reason => { void stop(reason); });
        await guard.prepare(prepared.directory);
        demand(!stopping, 'SESSION_STOPPED');
        leaseSnapshot = lease.activate();
        await guard.activate(leaseSnapshot);
        demandActive();
        const candidate = await startService({ host: '127.0.0.1', port: 8890, mcpPath: '/mcp', backendMode: 'disabled', localTokenFile: prepared.localTokenFile, localHeaderIsOwnerAuthority: false, deadlineWallMs: leaseSnapshot.deadlineWallMs, signal: abort.signal });
        demand(candidate && typeof candidate.disable === 'function' && typeof candidate.close === 'function', 'SERVICE_LIFECYCLE_INVALID');
        if (stopping || !lease.check()) {
          candidate.disable();
          Promise.resolve().then(() => candidate.close()).catch(() => {});
          throw new Error('SESSION_STOPPED');
        }
        service = candidate;
        demandActive();
        await guard.startTunnel({ ...approvedTunnel, privateDir: prepared.directory });
        demandActive();
        state = 'ACTIVE';
        return this.snapshot();
      } catch (error) {
        await stop('START_FAILED');
        throw new Error(['ACCOUNT_WORKSPACE_EVIDENCE_REQUIRED', 'PRIVATE_TUNNEL_EVIDENCE_REQUIRED', 'BILLING_KEY_PROBE_FORBIDDEN', 'TRUSTED_OWNER_AUTHORIZATION_NOT_INSTALLED', 'EXECUTION_ADAPTER_NOT_INSTALLED'].includes(error.message) ? error.message : 'SESSION_START_FAILED');
      }
    },
    assertEffectsAllowed() {
      demandActive();
      throw new Error('TRUSTED_OWNER_AUTHORIZATION_NOT_INSTALLED');
    },
  });
}

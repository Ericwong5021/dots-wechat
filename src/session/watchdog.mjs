import { spawn, fork } from 'node:child_process';
import { unlinkSync, rmdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHardLease } from './hard-lease.mjs';

const ownFiles = ['runtime-key', 'local-token', 'empty.yaml'];
const fail = code => { throw new Error(code); };

export function sanitizedEnvironment(source = {}) {
  const result = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    if (typeof source[name] === 'string' && !/[\r\n\0]/u.test(source[name])) result[name] = source[name];
  }
  return result;
}

export function tunnelCommand({ binary, version, tunnelId, privateDir }) {
  if (!isAbsolute(binary ?? '') || !['0.0.14', '0.0.15'].includes(version)) fail('VERIFIED_BINARY_REQUIRED');
  if (!/^tunnel_[A-Za-z0-9_-]{8,128}$/u.test(tunnelId ?? '') || !isAbsolute(privateDir ?? '')) fail('TUNNEL_ID_OR_PRIVATE_DIRECTORY_INVALID');
  return Object.freeze({ command: binary, args: Object.freeze([
    'run', '--config', join(privateDir, 'empty.yaml'),
    '--control-plane.tunnel-id', tunnelId,
    '--control-plane.api-key', `file:${join(privateDir, 'runtime-key')}`,
    '--mcp.server-url', 'http://127.0.0.1:8890/mcp',
    '--mcp.extra-headers', `X-Dots-Local-Token: file:${join(privateDir, 'local-token')}`,
    '--health.listen-addr', '127.0.0.1:0',
  ]) });
}

export function createWatchdogCore({ spawnChild, killRunner, cleanup, leaseOptions = {}, setRepeater = setInterval, clearRepeater = clearInterval, notify = () => {} }) {
  let child = null, stopped = false, repeat, exitCode = null;
  const stop = (reason, forceRunner = false) => {
    if (stopped) return;
    stopped = true;
    lease.stop();
    if (repeat !== undefined) clearRepeater(repeat);
    try { child?.kill('SIGKILL'); } catch {}
    if (forceRunner) killRunner();
    try { cleanup(); } catch {}
    try { notify({ kind: 'STOPPED', reason }); } catch {}
  };
  const lease = createHardLease({ ...leaseOptions, onExpire: reason => stop(reason, true) });
  return Object.freeze({
    stop,
    activate(bounds) {
      if (stopped) fail('WATCHDOG_STOPPED');
      const result = lease.activate(bounds);
      repeat = setRepeater(() => lease.check(), 100);
      return result;
    },
    startTunnel(spec, env) {
      if (stopped || child || !lease.check()) fail('TUNNEL_START_REJECTED');
      const invocation = tunnelCommand(spec);
      child = spawnChild(invocation.command, invocation.args, { env: sanitizedEnvironment(env), stdio: 'ignore', shell: false });
      child.once('error', () => stop('TUNNEL_START_FAILED', true));
      child.once('exit', code => { exitCode = code; stop('TUNNEL_EXITED', true); });
      return Object.freeze({ started: true, readiness: 'NOT_VERIFIED', processId: child.pid ?? null });
    },
    check: lease.check,
    snapshot: () => Object.freeze({ ...lease.snapshot(), stopped, tunnelStarted: child !== null, exitCode }),
  });
}

export function createNativeWatchdog({ env = {} } = {}) {
  const child = fork(fileURLToPath(import.meta.url), [], { env: sanitizedEnvironment(env), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let counter = 0, closed = false, onStopped = () => {};
  const pending = new Map();
  child.on('message', message => {
    if (message.kind === 'STOPPED') onStopped(message.reason);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message.result);
  });
  child.once('exit', () => {
    closed = true;
    onStopped('WATCHDOG_EXITED');
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('WATCHDOG_EXITED')); }
    pending.clear();
  });
  const send = (kind, value = {}) => new Promise((resolve, reject) => {
    if (closed || !child.connected) return reject(new Error('WATCHDOG_UNAVAILABLE'));
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('WATCHDOG_ACK_TIMEOUT')); }, 2000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, kind, ...value }, error => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error('WATCHDOG_SEND_FAILED'));
    });
  });
  return Object.freeze({
    processId: child.pid,
    onStopped(callback) { onStopped = callback; },
    prepare: privateDir => send('PREPARE', { privateDir }),
    activate: bounds => send('ACTIVATE', { bounds }),
    startTunnel: spec => send('TUNNEL', { spec }),
    stop: reason => send('STOP', { reason }),
  });
}

function startWatchdogProcess() {
  if (!process.send || !process.connected) fail('IPC_PARENT_REQUIRED');
  const runnerPid = process.ppid;
  let privateDir = null, prepared = false;
  const cleanup = () => {
    if (!privateDir) return;
    for (const name of ownFiles) { try { unlinkSync(join(privateDir, name)); } catch {} }
    try { rmdirSync(privateDir); } catch {}
  };
  const core = createWatchdogCore({
    spawnChild: spawn,
    killRunner: () => { try { process.kill(runnerPid, 'SIGKILL'); } catch {} },
    cleanup,
    notify: value => { if (process.connected) process.send(value); },
  });
  const preparationTimer = setTimeout(() => { core.stop('PREPARATION_TIMEOUT', true); process.exit(1); }, 10000);
  process.on('message', message => {
    let result;
    try {
      if (message.kind === 'PREPARE') {
        if (prepared || !isAbsolute(message.privateDir ?? '') || !/\/dots-wechat-session-[A-Za-z0-9]+$/u.test(message.privateDir)) fail('PRIVATE_DIRECTORY_INVALID');
        privateDir = message.privateDir;
        prepared = true;
        result = { prepared: true };
      } else if (message.kind === 'ACTIVATE') {
        if (!prepared) fail('WATCHDOG_NOT_PREPARED');
        if (!Number.isFinite(message.bounds?.deadlineWallMs) || !Number.isFinite(message.bounds?.deadlineMonoMs)) fail('FIXED_DEADLINE_REQUIRED');
        result = core.activate(message.bounds);
        clearTimeout(preparationTimer);
      } else if (message.kind === 'TUNNEL') {
        if (message.spec?.privateDir !== privateDir) fail('PRIVATE_DIRECTORY_MISMATCH');
        result = core.startTunnel(message.spec, process.env);
      } else if (message.kind === 'STOP') {
        core.stop('PARENT_STOP');
        result = { stopped: true };
      } else fail('UNKNOWN_WATCHDOG_MESSAGE');
      if (process.connected) process.send({ id: message.id, result }, () => { if (message.kind === 'STOP') process.exit(0); });
    } catch {
      if (process.connected) process.send({ id: message.id, error: 'WATCHDOG_REQUEST_REJECTED' });
    }
  });
  process.once('disconnect', () => { core.stop('PARENT_DISCONNECT'); process.exit(0); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { core.stop(signal, true); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startWatchdogProcess();

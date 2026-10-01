import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createWeixinQrBinding, WEIXIN_BINDING_PROTOCOL } from './binding.mjs';
import { createWeixinTextClient } from './client.mjs';
import { createPrivateStateStore } from './private-state-store.mjs';

export const CLI_USAGE = `node src/weixin/cli.mjs login --state-dir PATH
node src/weixin/cli.mjs status --state-dir PATH
node src/weixin/cli.mjs verify --state-dir PATH --expect TEXT [--reply-text TEXT] [--max-polls 1..10] [--timeout-seconds 1..120]
node src/weixin/cli.mjs logout --state-dir PATH
login and logout require an interactive terminal and typed confirmation.
login requires a new directory; its existing parent must be private and canonical.
verify defaults: at most 3 polls and 60 seconds. Replies require --reply-text.
API_ACCEPTED means provider acceptance, not confirmed delivery; uncertain sends are never retried.
logout deletes only this directory's local credentials and verify state; no remote unbinding.`;

class CliError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CliError(code); };
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const printableText = (value, units, bytes) => typeof value === 'string' && value.trim().length > 0 && value.length <= units && value.isWellFormed() && Buffer.byteLength(value) <= bytes;

function parse(argv) {
  if (argv.length === 0 || argv.length === 1 && ['help', '--help', '-h'].includes(argv[0])) return { command: 'help' };
  const [command, ...rest] = argv;
  if (!['login', 'status', 'verify', 'logout'].includes(command)) fail('UNKNOWN_COMMAND');
  const allowed = new Set(['--state-dir', ...(command === 'verify' ? ['--expect', '--reply-text', '--max-polls', '--timeout-seconds'] : [])]);
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!allowed.has(flag) || Object.hasOwn(flags, flag) || typeof rest[i + 1] !== 'string' || rest[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    flags[flag] = rest[i + 1];
  }
  if (!flags['--state-dir']) fail('STATE_DIR_REQUIRED');
  const stateDir = path.resolve(flags['--state-dir']);
  if (stateDir === path.parse(stateDir).root || /[\x00-\x1f\x7f]/u.test(stateDir) || stateDir.split(path.sep).some(part => ['.openclaw', '.hermes'].includes(part.toLowerCase()))) fail('STATE_DIR_FORBIDDEN');
  const result = { command, stateDir };
  if (command === 'verify') {
    const expect = flags['--expect'];
    const replyText = flags['--reply-text'];
    if (!printableText(expect, 4000, 16000) || replyText !== undefined && !printableText(replyText, 800, 2048)) fail('INVALID_TEXT');
    const count = flags['--max-polls'] ?? '3';
    const seconds = flags['--timeout-seconds'] ?? '60';
    if (!/^[1-9][0-9]*$/.test(count) || Number(count) > 10 || !/^[1-9][0-9]*$/.test(seconds) || Number(seconds) > 120) fail('INVALID_BOUND');
    Object.assign(result, { expect, replyText, maxPolls: Number(count), timeoutMs: Number(seconds) * 1000 });
  }
  return result;
}

async function checkDirectory(directory, exactPrivate = true) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.geteuid !== 'function' || stat.uid !== process.geteuid() || await fs.realpath(directory) !== directory || (exactPrivate ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0)) fail('STATE_DIRECTORY_INSECURE');
  return stat;
}

async function readCredential(stateDir) {
  const directory = await checkDirectory(stateDir);
  const filename = path.join(stateDir, 'credentials.json');
  const before = await fs.lstat(filename);
  const valid = stat => stat.isFile() && stat.uid === process.geteuid() && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1 && stat.size <= 16384;
  if (!valid(before) || !constants.O_NOFOLLOW) fail('CREDENTIAL_INSECURE');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = await handle.stat();
    if (!valid(after) || !identity(before, after)) fail('CREDENTIAL_CHANGED');
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384 || bytesRead !== after.size) fail('CREDENTIAL_INVALID');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))); } catch { fail('CREDENTIAL_INVALID'); }
    const fields = ['schemaVersion', 'provider', 'baseUrl', 'botToken', 'botId', 'ownerUserId', 'createdAtMs'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1 || value.provider !== 'tencent-weixin-ilink' || value.baseUrl !== WEIXIN_BINDING_PROTOCOL.origin || typeof value.botToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.botToken) || typeof value.botId !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(value.botId) || typeof value.ownerUserId !== 'string' || !/^[A-Za-z0-9_.@-]{1,256}$/.test(value.ownerUserId) || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) fail('CREDENTIAL_INVALID');
    if (!identity(directory, await checkDirectory(stateDir))) fail('STATE_DIRECTORY_CHANGED');
    return value;
  } finally { await handle.close(); }
}

async function renderLocalQr(payload, filename) {
  const { default: QRCode } = await import('qrcode');
  const png = await QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', width: 512 });
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(png); } finally { await handle.close(); }
}

async function login(options, io) {
  if (!io.isTerminal) fail('INTERACTIVE_TERMINAL_REQUIRED');
  await checkDirectory(path.dirname(options.stateDir), false);
  try { await fs.lstat(options.stateDir); fail('STATE_DIR_ALREADY_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const consent = await io.ask('This creates a NEW Weixin bot binding for your own account and stores its token on this machine. Scan the QR yourself. Type BIND MY WECHAT to consent: ');
  if (consent !== 'BIND MY WECHAT') fail('CONSENT_NOT_GIVEN');
  try { await io.prepareQr(); } catch { fail('QR_DEPENDENCY_UNAVAILABLE'); }
  let qrDirectory;
  let localDeadline;
  const binding = io.createBinding({ enabled: true, fetchImpl: io.fetchImpl });
  const cancellation = new AbortController();
  const cancel = () => { cancellation.abort(); binding.dispose(); };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const started = await binding.requestQrOnce();
    localDeadline = setTimeout(cancel, Math.max(0, started.expiresAtMs - Date.now()));
    qrDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dots-wechat-qr-')));
    await fs.chmod(qrDirectory, 0o700);
    const qrPath = path.join(qrDirectory, 'binding.png');
    await io.renderQr(binding.qrDisplayPayload(started.session).payload, qrPath);
    io.write(`Open this local PNG and scan it with your own WeChat. Local waiting is limited to five minutes; the provider may expire it earlier. The PNG is removed when login ends:\n${pathToFileURL(qrPath).href}\n`);
    let verifyCode;
    for (let poll = 0; poll < WEIXIN_BINDING_PROTOCOL.maxPolls; poll++) {
      const result = await binding.pollOnce(started.session, verifyCode === undefined ? {} : { verifyCode });
      verifyCode = undefined;
      if (result.status === 'confirmed') {
        await binding.saveConfirmedBinding(result.proof, { credentialPath: path.join(options.stateDir, 'credentials.json'), allowPersistence: true });
        io.result({ status: 'BOUND', ownerRestricted: true, localPersistence: true });
        return 0;
      }
      if (result.status === 'need_verifycode') verifyCode = await io.ask('Enter the verification code shown by WeChat: ', { signal: cancellation.signal });
      else if (['expired', 'verify_code_blocked'].includes(result.status)) fail('BINDING_EXPIRED_RESTART_WITH_NEW_CONSENT');
      else if (result.status === 'redirect_requires_verification') fail('PROVIDER_REDIRECT_UNSUPPORTED');
      else if (!['wait', 'scaned', 'scaned_but_redirect'].includes(result.status)) fail('BINDING_STATUS_UNSUPPORTED');
      await io.pause(1000);
    }
    fail('BINDING_POLL_LIMIT');
  } finally {
    clearTimeout(localDeadline);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    binding.dispose();
    if (qrDirectory) await fs.rm(qrDirectory, { recursive: true, force: true });
  }
}

async function verify(options, io) {
  const credential = await readCredential(options.stateDir);
  let stateStore;
  let client;
  let timer;
  let deadlineReached = false;
  let interrupted = false;
  const stop = () => { if (client) void client.close().catch(() => {}); };
  const interrupt = () => { interrupted = true; stop(); };
  const stopResult = () => {
    io.result({ status: interrupted ? 'VERIFY_INTERRUPTED' : 'VERIFY_DEADLINE', ownerRestricted: true, replyAttempted: false });
    return 2;
  };
  io.signalSource.on('SIGINT', interrupt);
  io.signalSource.on('SIGTERM', interrupt);
  try {
    stateStore = await io.createStateStore({ statePath: path.join(options.stateDir, 'verify-state.json') });
    if (interrupted) return stopResult();
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        init.signal.removeEventListener('abort', abort);
        fn(value);
      };
      const abort = () => finish(reject, new Error('TRANSPORT_ABORTED'));
      if (init.signal.aborted) { abort(); return; }
      init.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => finished ? undefined : io.fetchImpl(url, init)).then(value => finish(resolve, value), error => finish(reject, error));
    });
    client = io.createClient({ enabled: true, botToken: credential.botToken, botId: credential.botId, ownerUserId: credential.ownerUserId, fetchImpl, stateStore, timeoutMs: Math.min(options.timeoutMs, 15000), pollTimeoutMs: Math.min(options.timeoutMs, 10000) });
    timer = setTimeout(() => { deadlineReached = true; stop(); }, options.timeoutMs);
    const ready = await client.initialize();
    if (interrupted || deadlineReached) return stopResult();
    if (ready.status !== 'OK') fail(ready.status);
    let batch = await client.pendingMessages();
    let polls = 0;
    while (true) {
      if (interrupted || deadlineReached) return stopResult();
      if (batch.status !== 'OK') fail(batch.status);
      const matches = batch.messages.filter(message => message.text === options.expect);
      if (matches.length > 1) fail('AMBIGUOUS_EXPECT');
      if (matches.length === 1) {
        if (options.replyText === undefined) {
          io.result({ status: 'OWNER_MESSAGE_MATCHED', ownerRestricted: true, replyAttempted: false });
          return 0;
        }
        const sent = await client.sendText({ inbound: matches[0], text: options.replyText });
        if ((interrupted || deadlineReached) && sent.attempted !== true) return stopResult();
        if ((interrupted || deadlineReached) && sent.status === 'API_ACCEPTED') {
          io.result({ status: interrupted ? 'VERIFY_INTERRUPTED' : 'VERIFY_DEADLINE', ownerRestricted: true, replyAttempted: true, deliveryConfirmed: false });
          return 2;
        }
        io.result({ status: sent.status, ownerRestricted: true, replyAttempted: sent.attempted === true, deliveryConfirmed: false, ...(sent.storageStatus ? { storageStatus: sent.storageStatus } : {}) });
        return sent.status === 'API_ACCEPTED' ? 0 : 2;
      }
      if (polls >= options.maxPolls) break;
      polls++;
      batch = await client.getUpdates();
    }
    io.result({ status: deadlineReached ? 'VERIFY_DEADLINE' : 'EXPECT_NOT_SEEN', ownerRestricted: true, replyAttempted: false });
    return 2;
  } finally {
    clearTimeout(timer);
    try {
      if (client) await client.close(); else if (stateStore) await stateStore.close();
    } finally {
      io.signalSource.off('SIGINT', interrupt);
      io.signalSource.off('SIGTERM', interrupt);
    }
  }
}

async function logout(options, io) {
  if (!io.isTerminal) fail('INTERACTIVE_TERMINAL_REQUIRED');
  await readCredential(options.stateDir);
  if (await io.ask('Delete only these local Dots WeChat credentials and verify state? This does not unbind WeChat remotely. Type DELETE LOCAL DOTS WECHAT: ') !== 'DELETE LOCAL DOTS WECHAT') fail('CONSENT_NOT_GIVEN');
  const store = await io.createStateStore({ statePath: path.join(options.stateDir, 'verify-state.json') });
  try {
    const names = await fs.readdir(options.stateDir);
    if (names.some(name => !['credentials.json', 'verify-state.json', 'verify-state.json.lock'].includes(name))) fail('UNRECOGNIZED_STATE_FILES');
    for (const name of ['verify-state.json', 'credentials.json']) {
      const filename = path.join(options.stateDir, name);
      let stat;
      try { stat = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT' && name === 'verify-state.json') continue; throw error; }
      if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) fail('LOCAL_FILE_INSECURE');
    }
    await fs.unlink(path.join(options.stateDir, 'verify-state.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(path.join(options.stateDir, 'credentials.json'));
  } finally { await store.close(); }
  await fs.rmdir(options.stateDir);
  io.result({ status: 'LOCAL_CREDENTIALS_DELETED', remoteUnbinding: false });
  return 0;
}

export async function runCli(argv, overrides = {}) {
  const io = {
    isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    write: text => process.stdout.write(text),
    error: text => process.stderr.write(text),
    ask: async (prompt, options) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(prompt, options); } finally { rl.close(); }
    },
    fetchImpl: globalThis.fetch,
    pause: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    renderQr: renderLocalQr,
    createBinding: createWeixinQrBinding,
    createClient: createWeixinTextClient,
    createStateStore: createPrivateStateStore,
    signalSource: process,
    prepareQr: overrides.renderQr ? async () => {} : async () => { await import('qrcode'); },
    ...overrides,
  };
  io.result = value => io.write(`${JSON.stringify(value)}\n`);
  try {
    const options = parse(argv);
    if (options.command === 'help') { io.write(`${CLI_USAGE}\n`); return 0; }
    if (options.command === 'login') return await login(options, io);
    if (options.command === 'verify') return await verify(options, io);
    if (options.command === 'logout') return await logout(options, io);
    try { await readCredential(options.stateDir); }
    catch (error) { if (error.code === 'ENOENT') { io.result({ status: 'NOT_BOUND' }); return 0; } throw error; }
    io.result({ status: 'LOCALLY_BOUND', ownerRestricted: true, tokenPresent: true, credentialMode: '0600', directoryMode: '0700', networkChecked: false });
    return 0;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : 'CLI_OPERATION_FAILED';
    io.error(`${JSON.stringify({ status: 'ERROR', code })}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await runCli(process.argv.slice(2));

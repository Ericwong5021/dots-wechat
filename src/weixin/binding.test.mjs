import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWeixinQrBinding, WEIXIN_BINDING_PROTOCOL } from './binding.mjs';

const ORIGIN = WEIXIN_BINDING_PROTOCOL.origin;
const qrFixture = () => ({ qrcode: 'fictional-qr-session', qrcode_img_content: 'https://weixin.qq.com/fictional-qr-display' });
const confirmedFixture = () => ({ status: 'confirmed', bot_token: 'fictional-bot-token-never-live', ilink_bot_id: 'fictional-bot@im.bot', ilink_user_id: 'fictional-owner@im.wechat', baseurl: ORIGIN });
const response = (value, init = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...init });
const hasCode = (code) => (error) => error.code === code && error.message === code;

function fixture(sequence, options = {}) {
  const calls = [];
  const binding = createWeixinQrBinding({
    enabled: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = sequence.shift();
      if (typeof next === 'function') return next(url, init);
      return response(next);
    },
    ...options,
  });
  return { binding, calls };
}

async function confirmed(options) {
  const prepared = fixture([qrFixture(), confirmedFixture()], options);
  const started = await prepared.binding.requestQrOnce();
  const result = await prepared.binding.pollOnce(started.session);
  return { ...prepared, started, result };
}

async function privateTemp(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dots-wechat-binding-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('default factory is inert, disabled, and requires injected transport', async () => {
  let called = false;
  const binding = createWeixinQrBinding({ fetchImpl: () => { called = true; } });
  await assert.rejects(binding.requestQrOnce(), hasCode('BINDING_DISABLED'));
  assert.equal(called, false);
  await assert.rejects(createWeixinQrBinding({ enabled: true }).requestQrOnce(), hasCode('EXPLICIT_TRANSPORT_REQUIRED'));
});

test('QR POST uses fixed official origin, empty prior tokens and safe request controls', async () => {
  const { binding, calls } = fixture([qrFixture()]);
  const result = await binding.requestQrOnce();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}/ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { local_token_list: [] });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(calls[0].init.headers['iLink-App-Id'], 'bot');
  assert.equal(calls[0].init.headers['iLink-App-ClientVersion'], '132105');
  assert.match(Buffer.from(calls[0].init.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, undefined);
  assert.equal(result.status, 'qr_ready');
  assert.equal(JSON.stringify(result).includes('fictional'), false);
  assert.deepEqual(binding.qrDisplayPayload(result.session), { format: 'opaque-qr-payload', payload: qrFixture().qrcode_img_content });
  assert.throws(() => binding.qrDisplayPayload({}), hasCode('INVALID_BINDING_SESSION'));
  await assert.rejects(binding.requestQrOnce(), hasCode('QR_ALREADY_REQUESTED'));
  assert.equal(calls.length, 1);
});

test('existing-account options cannot enter token list or request headers', async () => {
  const { binding, calls } = fixture([qrFixture()], { localTokenList: ['never-use-existing-token'], baseUrl: 'https://example.invalid', accountPath: '/nonexistent/.openclaw/credentials' });
  await binding.requestQrOnce();
  assert.equal(JSON.stringify(calls).includes('never-use-existing-token'), false);
  assert.equal(JSON.stringify(calls).includes('example.invalid'), false);
});

test('one GET poll returns safe state and carries no authentication or prior tokens', async () => {
  const { binding, calls } = fixture([qrFixture(), { status: 'wait' }]);
  const { session } = await binding.requestQrOnce();
  assert.deepEqual(await binding.pollOnce(session), { status: 'wait', requiresUserAction: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${ORIGIN}/ilink/bot/get_qrcode_status?qrcode=fictional-qr-session`);
  assert.deepEqual(calls[1].init.headers, { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132105' });
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.body, undefined);
});

test('manual verification code is required only after provider requested it', async () => {
  const { binding, calls } = fixture([qrFixture(), { status: 'need_verifycode' }, { status: 'scaned' }]);
  const { session } = await binding.requestQrOnce();
  await assert.rejects(binding.pollOnce(session, { verifyCode: '123456' }), hasCode('INVALID_VERIFICATION_CODE'));
  assert.equal((await binding.pollOnce(session)).requiresUserAction, true);
  await assert.rejects(binding.pollOnce(session), hasCode('VERIFICATION_CODE_REQUIRED'));
  await assert.rejects(binding.pollOnce(session, { verifyCode: '12\n34' }), hasCode('INVALID_VERIFICATION_CODE'));
  assert.equal((await binding.pollOnce(session, { verifyCode: '123456' })).status, 'scaned');
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[2].url).searchParams.get('verify_code'), '123456');
});

for (const status of ['expired', 'verify_code_blocked']) {
  test(`${status} stops without automatic QR refresh`, async () => {
    const { binding, calls } = fixture([qrFixture(), { status }]);
    const { session } = await binding.requestQrOnce();
    assert.deepEqual(await binding.pollOnce(session), { status, requiresNewApproval: true });
    await assert.rejects(binding.pollOnce(session), hasCode('INVALID_BINDING_SESSION'));
    assert.equal(calls.length, 2);
  });
}

for (const [status, code] of [['binded_redirect', 'EXISTING_BINDING_NOT_IMPORTED'], ['unknown', 'PROVIDER_STATUS_INVALID']]) {
  test(`${status} cannot import existing credentials or redirect QR secret`, async () => {
    const { binding, calls } = fixture([qrFixture(), { status, redirect_host: 'attacker.invalid', bot_token: 'never-return-this' }]);
    const { session } = await binding.requestQrOnce();
    await assert.rejects(binding.pollOnce(session), hasCode(code));
    await assert.rejects(binding.pollOnce(session), hasCode('INVALID_BINDING_SESSION'));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ url }) => new URL(url).origin === ORIGIN));
  });
}

for (const baseurl of ['http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com.attacker.invalid', 'https://ilinkai.weixin.qq.com@attacker.invalid', 'https://ilinkai.weixin.qq.com:444', `${ORIGIN}/other`, `${ORIGIN}/?token=secret`, 'https://other.weixin.qq.com']) {
  test(`unsupported confirmed base URL fails closed (${baseurl ?? 'absent'})`, async () => {
    const { binding } = fixture([qrFixture(), { ...confirmedFixture(), baseurl }]);
    const { session } = await binding.requestQrOnce();
    await assert.rejects(binding.pollOnce(session), hasCode('UNSUPPORTED_PROVIDER_BASE_URL'));
  });
}

for (const altered of [{ bot_token: '' }, { bot_token: 'bad\r\nBearer' }, { bot_token: 'x'.repeat(4097) }, { ilink_bot_id: '../../escape/' }, { ilink_user_id: '' }]) {
  test(`confirmed credential validation rejects ${Object.keys(altered)[0]} fixture`, async () => {
    const { binding } = fixture([qrFixture(), { ...confirmedFixture(), ...altered }]);
    const { session } = await binding.requestQrOnce();
    await assert.rejects(binding.pollOnce(session), hasCode('PROVIDER_BINDING_INVALID'));
  });
}

test('confirmed results serialize without credentials, account identifiers, or QR payload', async () => {
  const { result, binding, started } = await confirmed();
  assert.equal(result.status, 'confirmed');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('fictional'), false);
  assert.equal(serialized.includes('botToken'), false);
  assert.deepEqual(result.proof, {});
  assert.equal(Object.isFrozen(result.proof), true);
  assert.throws(() => binding.qrDisplayPayload(started.session), hasCode('INVALID_BINDING_SESSION'));
});

test('confirmation proof cannot be forged, serialized, or borrowed from another factory', async () => {
  const { binding, result } = await confirmed();
  for (const proof of [{ status: 'confirmed', ...confirmedFixture() }, JSON.parse(JSON.stringify(result.proof)), undefined]) {
    await assert.rejects(binding.saveConfirmedBinding(proof, { allowPersistence: true, credentialPath: '/invalid/new/credentials.json' }), hasCode('INVALID_CONFIRMATION_PROOF'));
  }
  const other = fixture([]).binding;
  await assert.rejects(other.saveConfirmedBinding(result.proof, { allowPersistence: true }), hasCode('INVALID_CONFIRMATION_PROOF'));
});

test('persistence requires explicit opt-in and a new private canonical directory', async (t) => {
  const root = await privateTemp(t);
  const credentialPath = path.join(root, 'new-binding', 'credentials.json');
  const { binding, result } = await confirmed();
  await assert.rejects(binding.saveConfirmedBinding(result.proof, { credentialPath }), hasCode('PERSISTENCE_NOT_APPROVED'));
  const saved = await binding.saveConfirmedBinding(result.proof, { allowPersistence: true, credentialPath });
  assert.deepEqual(saved, { status: 'saved', provider: 'tencent-weixin-ilink', ownerRestricted: true, persisted: true });
  assert.equal((await stat(path.dirname(credentialPath))).mode & 0o777, 0o700);
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  const document = JSON.parse(await readFile(credentialPath, 'utf8'));
  assert.equal(document.botToken, confirmedFixture().bot_token);
  assert.equal(document.ownerUserId, confirmedFixture().ilink_user_id);
  assert.equal(document.baseUrl, ORIGIN);
  assert.equal(document.schemaVersion, 1);
  await assert.rejects(binding.saveConfirmedBinding(result.proof, { allowPersistence: true, credentialPath: path.join(root, 'second-binding', 'credentials.json') }), hasCode('INVALID_CONFIRMATION_PROOF'));
});

test('pre-existing destination and file are never overwritten', async (t) => {
  const root = await privateTemp(t);
  const target = path.join(root, 'existing');
  await mkdir(target, { mode: 0o700 });
  const credentialPath = path.join(target, 'credentials.json');
  await writeFile(credentialPath, 'fictional-existing-sentinel', { mode: 0o600 });
  const { binding, result } = await confirmed();
  await assert.rejects(binding.saveConfirmedBinding(result.proof, { credentialPath, allowPersistence: true }), hasCode('CREDENTIAL_SAVE_FAILED_NO_RETRY'));
  assert.equal(await readFile(credentialPath, 'utf8'), 'fictional-existing-sentinel');
  await assert.rejects(binding.saveConfirmedBinding(result.proof, { credentialPath, allowPersistence: true }), hasCode('INVALID_CONFIRMATION_PROOF'));
});

test('concurrent save calls have exactly one successful persistent write', async (t) => {
  const root = await privateTemp(t);
  const { binding, result } = await confirmed();
  const attempts = await Promise.allSettled(['first', 'second'].map((name) => binding.saveConfirmedBinding(result.proof, { allowPersistence: true, credentialPath: path.join(root, name, 'credentials.json') })));
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
});

for (const target of ['relative/credentials.json', '/private/tmp/../new/credentials.json', '/private/tmp/.openclaw/new/credentials.json', '/private/tmp/.hermes/new/credentials.json', '/private/tmp/new/arbitrary.json']) {
  test(`unsafe storage destination rejected before writing: ${target}`, async () => {
    const { binding, result } = await confirmed();
    await assert.rejects(binding.saveConfirmedBinding(result.proof, { credentialPath: target, allowPersistence: true }), (error) => ['INVALID_CREDENTIAL_PATH', 'EXISTING_ACCOUNT_STORAGE_FORBIDDEN'].includes(error.code));
  });
}

test('storage ancestor symlink is rejected', async (t) => {
  const root = await privateTemp(t);
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias);
  const { binding, result } = await confirmed();
  await assert.rejects(binding.saveConfirmedBinding(result.proof, { credentialPath: path.join(alias, 'new', 'credentials.json'), allowPersistence: true }), hasCode('NON_CANONICAL_CREDENTIAL_PATH'));
});

test('QR lifetime is finite and clock reversal cannot extend it', async () => {
  let time = 1_000;
  const { binding, calls } = fixture([qrFixture()], { now: () => time });
  const { session } = await binding.requestQrOnce();
  time += WEIXIN_BINDING_PROTOCOL.sessionTtlMs;
  await assert.rejects(binding.pollOnce(session), hasCode('BINDING_EXPIRED'));
  assert.equal(calls.length, 1);
  time = 2_000;
  const reverse = fixture([qrFixture()], { now: () => time });
  const started = await reverse.binding.requestQrOnce();
  time = 1_999;
  await assert.rejects(reverse.binding.pollOnce(started.session), hasCode('BINDING_EXPIRED'));
});

test('confirmation proof expires before persistence', async () => {
  let time = 1_000;
  const { binding, result } = await confirmed({ now: () => time });
  time += WEIXIN_BINDING_PROTOCOL.sessionTtlMs;
  await assert.rejects(binding.saveConfirmedBinding(result.proof, { credentialPath: '/invalid/new/credentials.json', allowPersistence: true }), hasCode('CONFIRMATION_EXPIRED'));
});

test('concurrent polls are rejected and no implicit repeated polling occurs', async () => {
  let release;
  const { binding, calls } = fixture([qrFixture(), () => new Promise((resolve) => { release = resolve; })]);
  const { session } = await binding.requestQrOnce();
  const running = binding.pollOnce(session);
  await assert.rejects(binding.pollOnce(session), hasCode('POLL_ALREADY_RUNNING'));
  release(response({ status: 'wait' }));
  await running;
  assert.equal(calls.length, 2);
});

test('QR request and body-reading timeout are bounded even for an inert transport', async () => {
  const { binding, calls } = fixture([() => new Promise(() => {})], { requestTimeoutMs: 10 });
  await assert.rejects(binding.requestQrOnce(), hasCode('PROVIDER_REQUEST_TIMEOUT'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
  await assert.rejects(binding.requestQrOnce(), hasCode('QR_ALREADY_REQUESTED'));
  const slowBody = fixture([() => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } })], { requestTimeoutMs: 10 });
  await assert.rejects(slowBody.binding.requestQrOnce(), hasCode('PROVIDER_REQUEST_TIMEOUT'));
});

test('error content and thrown transport secrets are never included in errors', async () => {
  const secret = 'fictional-never-disclose-token';
  for (const bad of [() => { throw new Error(secret); }, () => response({ errmsg: secret }, { status: 403 }), () => response({ ret: -1, errmsg: secret })]) {
    const { binding } = fixture([bad]);
    await assert.rejects(binding.requestQrOnce(), (error) => !String(error.stack).includes(secret) && !JSON.stringify(error).includes(secret));
  }
});

for (const bad of [() => response(qrFixture(), { status: 302 }), () => response(qrFixture(), { headers: { 'Content-Type': 'text/html' } }), () => new Response('x'.repeat(16_385), { headers: { 'Content-Type': 'application/json' } }), () => new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }), () => response([]), () => response({ ...qrFixture(), qrcode_img_content: 'javascript:alert(1)' }), () => response({ ...qrFixture(), qrcode_img_content: '<img src=x>' }), () => response({ ...qrFixture(), qrcode: 'bad\nvalue' })]) {
  test('malformed provider response fails closed without retry', async () => {
    const { binding, calls } = fixture([bad]);
    await assert.rejects(binding.requestQrOnce());
    assert.equal(calls.length, 1);
    await assert.rejects(binding.requestQrOnce(), hasCode('QR_ALREADY_REQUESTED'));
  });
}

test('dispose invalidates session and confirmation proof', async () => {
  const { binding, result } = await confirmed();
  binding.dispose();
  await assert.rejects(binding.saveConfirmedBinding(result.proof, { allowPersistence: true }), hasCode('BINDING_DISPOSED'));
  await assert.rejects(binding.requestQrOnce(), hasCode('BINDING_DISPOSED'));
});

for (const checkpoint of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  for (const interrupt of ['dispose', 'expire']) {
    test(`${interrupt} at save checkpoint ${checkpoint} prevents success and removes only new files`, async (t) => {
      const root = await privateTemp(t);
      const credentialPath = path.join(root, 'new-binding', 'credentials.json');
      const sentinel = path.join(root, 'untouched.txt');
      await writeFile(sentinel, 'fictional-unrelated-file');
      let time = 1_000;
      let checks = 0;
      let saving = false;
      let activeBinding;
      const { binding, result } = await confirmed({ now: () => {
        if (saving && ++checks === checkpoint) {
          if (interrupt === 'dispose') activeBinding.dispose();
          else time += WEIXIN_BINDING_PROTOCOL.sessionTtlMs;
        }
        return time;
      } });
      activeBinding = binding;
      saving = true;
      await assert.rejects(binding.saveConfirmedBinding(result.proof, { credentialPath, allowPersistence: true }));
      await assert.rejects(stat(credentialPath), { code: 'ENOENT' });
      assert.equal(await readFile(sentinel, 'utf8'), 'fictional-unrelated-file');
    });
  }
}

test('provider transport cannot smuggle secret via exported error class', async () => {
  const { WeixinBindingError } = await import('./binding.mjs');
  const { binding } = fixture([() => { throw new WeixinBindingError('fictional-sensitive-value'); }]);
  await assert.rejects(binding.requestQrOnce(), hasCode('PROVIDER_REQUEST_FAILED'));
});

test('official observed octet-stream JSON is accepted without weakening body validation', async () => {
  const { binding } = fixture([() => response(qrFixture(), { headers: { 'content-type': 'application/octet-stream' } })]);
  const result = await binding.requestQrOnce();
  assert.equal(result.status, 'qr_ready');
  binding.dispose();
});

test('octet-stream still requires valid bounded UTF-8 JSON object', async () => {
  const { binding } = fixture([() => new Response('not JSON', { headers: { 'content-type': 'application/octet-stream' } })]);
  await assert.rejects(binding.requestQrOnce(), hasCode('PROVIDER_RESPONSE_INVALID'));
  binding.dispose();
});


test('QR display and each poll remain paired to one response even with URL metacharacters', async () => {
  const token = 'fictional/+?=:% session'.replace(' ', '+');
  const display = 'https://weixin.qq.com/fictional-distinct-display?entry=one';
  const { binding, calls } = fixture([{ qrcode: token, qrcode_img_content: display }, { status: 'wait' }, { status: 'scaned' }, confirmedFixture()]);
  const { session } = await binding.requestQrOnce();
  assert.equal(binding.qrDisplayPayload(session).payload, display);
  assert.notEqual(binding.qrDisplayPayload(session).payload, token);
  for (const status of ['wait', 'scaned', 'confirmed']) assert.equal((await binding.pollOnce(session)).status, status);
  assert.equal(calls.filter(call => new URL(call.url).pathname.endsWith('/get_bot_qrcode')).length, 1);
  for (const call of calls.slice(1)) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get('qrcode'), token);
    assert.equal(url.searchParams.has('bot_type'), false);
    assert.equal(call.init.method, 'GET');
  }
  binding.dispose();
});

test('independent binding factories cannot exchange QR sessions or overwrite each other', async () => {
  const first = fixture([{ qrcode: 'fictional-first', qrcode_img_content: 'https://weixin.qq.com/fictional-first-display' }, { status: 'wait' }]);
  const second = fixture([{ qrcode: 'fictional-second', qrcode_img_content: 'https://weixin.qq.com/fictional-second-display' }, { status: 'wait' }]);
  const one = await first.binding.requestQrOnce();
  const two = await second.binding.requestQrOnce();
  await assert.rejects(first.binding.pollOnce(two.session), hasCode('INVALID_BINDING_SESSION'));
  assert.throws(() => first.binding.qrDisplayPayload(two.session), hasCode('INVALID_BINDING_SESSION'));
  await first.binding.pollOnce(one.session);
  await second.binding.pollOnce(two.session);
  assert.equal(new URL(first.calls[1].url).searchParams.get('qrcode'), 'fictional-first');
  assert.equal(new URL(second.calls[1].url).searchParams.get('qrcode'), 'fictional-second');
  assert.equal(first.binding.qrDisplayPayload(one.session).payload, 'https://weixin.qq.com/fictional-first-display');
  first.binding.dispose();
  second.binding.dispose();
});


test('verification code survives wait and is cleared after scaned', async () => {
  const { binding, calls } = fixture([qrFixture(), { status: 'need_verifycode' }, { status: 'wait' }, { status: 'wait' }, { status: 'scaned' }, confirmedFixture()]);
  const { session } = await binding.requestQrOnce();
  await binding.pollOnce(session);
  await binding.pollOnce(session, { verifyCode: '123456' });
  await assert.rejects(binding.pollOnce(session, { verifyCode: '654321' }), hasCode('INVALID_VERIFICATION_CODE'));
  await binding.pollOnce(session);
  await binding.pollOnce(session, { verifyCode: '123456' });
  await binding.pollOnce(session);
  assert.deepEqual(calls.slice(1).map(call => new URL(call.url).searchParams.get('verify_code')), [null, '123456', '123456', '123456', null]);
  binding.dispose();
});

test('repeated need_verifycode clears prior digits and requires new explicit input', async () => {
  const { binding, calls } = fixture([qrFixture(), { status: 'need_verifycode' }, { status: 'need_verifycode' }, { status: 'scaned' }]);
  const { session } = await binding.requestQrOnce();
  await binding.pollOnce(session);
  await binding.pollOnce(session, { verifyCode: '123456' });
  await assert.rejects(binding.pollOnce(session), hasCode('VERIFICATION_CODE_REQUIRED'));
  await binding.pollOnce(session, { verifyCode: '654321' });
  assert.equal(new URL(calls.at(-1).url).searchParams.get('verify_code'), '654321');
  binding.dispose();
});

test('verified initial-origin redirect retains the original QR for the next poll', async () => {
  const { binding, calls } = fixture([qrFixture(), { status: 'scaned_but_redirect', redirect_host: new URL(ORIGIN).hostname }, confirmedFixture()]);
  const { session } = await binding.requestQrOnce();
  assert.equal((await binding.pollOnce(session)).status, 'scaned_but_redirect');
  assert.equal((await binding.pollOnce(session)).status, 'confirmed');
  assert.equal(new URL(calls[2].url).searchParams.get('qrcode'), qrFixture().qrcode);
  binding.dispose();
});

test('unverified regional host pauses without sending the QR or discarding the session', async () => {
  const { binding, calls } = fixture([qrFixture(), { status: 'scaned_but_redirect', redirect_host: 'fictional-region.example.invalid' }]);
  const { session } = await binding.requestQrOnce();
  assert.deepEqual(await binding.pollOnce(session), { status: 'redirect_requires_verification', providerHost: 'fictional-region.example.invalid', requiresUserAction: true });
  await assert.rejects(binding.pollOnce(session), hasCode('PROVIDER_ORIGIN_VERIFICATION_REQUIRED'));
  assert.equal(binding.qrDisplayPayload(session).payload, qrFixture().qrcode_img_content);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => new URL(call.url).origin === ORIGIN));
  binding.dispose();
});

for (const host of ['127.0.0.1', 'https://attacker.invalid', 'good.invalid:443', 'good.invalid/path', 'good.invalid@attacker.invalid', 'good.invalid?token=x', 'good.invalid#x', '[::1]', 'good.invalid.', 'UPPER.invalid']) {
  test('redirect host parser rejects unsupported shape without sending secrets: ' + host, async () => {
    const { binding, calls } = fixture([qrFixture(), { status: 'scaned_but_redirect', redirect_host: host }]);
    const { session } = await binding.requestQrOnce();
    await assert.rejects(binding.pollOnce(session), hasCode('PROVIDER_REDIRECT_INVALID'));
    assert.equal(calls.length, 2);
    binding.dispose();
  });
}

test('diagnostic observations preserve correlation without disclosing QR, codes or credentials', async () => {
  const observations = [];
  const { binding } = fixture([qrFixture(), { status: 'need_verifycode' }, { status: 'scaned' }, confirmedFixture()], { onObservation: event => observations.push(event) });
  const { session } = await binding.requestQrOnce();
  await binding.pollOnce(session);
  await binding.pollOnce(session, { verifyCode: '123456' });
  await binding.pollOnce(session);
  const raw = JSON.stringify(observations);
  for (const secret of ['fictional', '123456', 'bot_token', 'ilink_user_id', 'qrcode_img_content']) assert.equal(raw.includes(secret), false);
  assert.ok(observations.filter(event => event.phase === 'poll_request').every(event => event.queryMatchesSession && event.verifiedOrigin));
  assert.equal(observations.at(-1).providerStatus, 'confirmed');
  assert.equal(observations.at(-1).hasBotToken, true);
  binding.dispose();
});

test('diagnostic observer failures do not turn a valid provider response into a retry', async () => {
  const { binding, calls } = fixture([qrFixture(), { status: 'wait' }], { onObservation: () => { throw new Error('observer failed'); } });
  const { session } = await binding.requestQrOnce();
  assert.equal((await binding.pollOnce(session)).status, 'wait');
  assert.equal(calls.length, 2);
  binding.dispose();
});

test('poll-count bound supports one-second sequential checks while remaining finite', async () => {
  const { binding, calls } = fixture([qrFixture(), ...Array.from({ length: 300 }, () => ({ status: 'wait' }))]);
  const { session } = await binding.requestQrOnce();
  for (let index = 0; index < 300; index++) await binding.pollOnce(session);
  await assert.rejects(binding.pollOnce(session), hasCode('POLL_LIMIT_REACHED'));
  assert.equal(calls.length, 301);
  binding.dispose();
});


for (const baseurl of [undefined, '']) {
  test('confirmed response without a base URL uses the documented default origin', async (t) => {
    const root = await privateTemp(t);
    const { binding } = fixture([qrFixture(), { ...confirmedFixture(), baseurl }]);
    const { session } = await binding.requestQrOnce();
    const result = await binding.pollOnce(session);
    assert.equal(result.status, 'confirmed');
    const credentialPath = path.join(root, 'new-binding', 'credentials.json');
    await binding.saveConfirmedBinding(result.proof, { credentialPath, allowPersistence: true });
    assert.equal(JSON.parse(await readFile(credentialPath, 'utf8')).baseUrl, ORIGIN);
    binding.dispose();
  });
}

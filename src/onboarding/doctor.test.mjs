import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function child(args) {
  const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('./doctor.mjs', import.meta.url)), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', value => { stdout += value; });
  process.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => process.kill('SIGKILL'), 15000);
  const code = await new Promise(resolve => process.once('close', resolve));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test('doctor performs actual disabled loopback discovery and closes its listener without login', async () => {
  const result = await child([]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'SELF_CHECK_PASSED');
  assert.equal(report.network, 'LOOPBACK_ONLY');
  assert.equal(report.credentialsRead, false);
  assert.equal(report.realBindingRequested, false);
  assert.equal(report.realMessagingEnabled, false);
  assert.equal(report.existingDot, 'not_verified');
  assert.equal(report.service, 'dots-wechat-local');
  assert.ok(report.checks.includes('PROTECTED_OPERATION_DENIED'));
  assert.ok(report.checks.includes('CLEAN_SHUTDOWN'));
  assert.equal(result.stderr, '');
});

test('doctor help exits normally without starting a check or exposing a runtime path', async () => {
  const result = await child(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No credentials, login, tunnel or real messaging/);
  assert.equal(result.stderr, '');
});

test('doctor rejects flags that imply live effects instead of accepting them silently', async () => {
  const result = await child(['--live']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { status: 'SELF_CHECK_FAILED', code: 'INVALID_ARGUMENTS' });
});

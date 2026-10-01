import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

function child(args) {
  return spawn(process.execPath, args, { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
}

test('importing service has no listener, timer, account lookup or other process lifetime', async () => {
  const process = child(['--input-type=module', '-e', 'await import("./server.mjs")']);
  const result = await once(process, 'exit', { signal: AbortSignal.timeout(3000) });
  assert.equal(result[0], 0);
});

test('CLI rejects unsupported live/host and excessive duration options without starting', async () => {
  for (const args of [['--host', '0.0.0.0'], ['--live', '1'], ['--duration-seconds', '1801']]) {
    const process = child(['cli.mjs', ...args]);
    let stdout = '', stderr = '';
    process.stdout.on('data', value => { stdout += value; });
    process.stderr.on('data', value => { stderr += value; });
    assert.equal((await once(process, 'exit', { signal: AbortSignal.timeout(3000) }))[0], 1);
    assert.equal(stdout, '');
    assert.deepEqual(JSON.parse(stderr), { code: 'START_FAILED', liveEnabled: false });
  }
});

test('actual foreground CLI exposes disabled health and SIGTERM closes only its listener', async t => {
  const process = child(['cli.mjs', '--port', '0', '--duration-seconds', '10']);
  t.after(() => { if (process.exitCode === null) process.kill('SIGTERM'); });
  const exit = once(process, 'exit', { signal: AbortSignal.timeout(4000) });
  const [chunk] = await once(process.stdout, 'data', { signal: AbortSignal.timeout(3000) });
  const line = JSON.parse(chunk.toString().trim());
  assert.equal(line.event, 'listening');
  assert.equal(line.host, '127.0.0.1');
  assert.equal(line.liveEnabled, false);
  const health = await (await fetch(new URL('/healthz', line.url))).json();
  assert.equal(health.configured, false);
  assert.equal(health.automaticPolling, false);
  process.kill('SIGTERM');
  assert.equal((await exit)[0], 0);
  await assert.rejects(fetch(new URL('/healthz', line.url), { signal: AbortSignal.timeout(1000) }));
});

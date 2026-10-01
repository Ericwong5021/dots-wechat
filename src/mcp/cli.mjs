import { startLocalMcpService } from './server.mjs';

const argv = process.argv.slice(2);
const options = { port: 8890, durationMs: 1800000 };
if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) {
  process.stdout.write('node src/mcp/cli.mjs [--port 0..65535] [--duration-seconds 1..1800]\nDisabled foreground MCP on 127.0.0.1 only. No credentials, login, tunnel or automatic polling.\n');
} else {
  try {
    if (argv.length % 2 !== 0) throw new Error('INVALID_ARGUMENTS');
    const used = new Set();
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index], raw = argv[index + 1];
      if (used.has(flag) || !/^\d+$/u.test(raw)) throw new Error('INVALID_ARGUMENTS');
      used.add(flag);
      if (flag === '--port') options.port = Number(raw);
      else if (flag === '--duration-seconds' && Number(raw) <= 1800 && Number(raw) > 0) options.durationMs = Number(raw) * 1000;
      else throw new Error('INVALID_ARGUMENTS');
    }
    const service = await startLocalMcpService(options);
    process.stdout.write(`${JSON.stringify({ event: 'listening', ...service.address, durationSeconds: options.durationMs / 1000, liveEnabled: false, automaticPolling: false })}\n`);
    const stop = async () => { await service.close(); process.stdout.write('{"event":"stopped"}\n'); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'START_FAILED', liveEnabled: false })}\n`);
    process.exitCode = 1;
  }
}

import { pathToFileURL } from 'node:url';
import { startLocalMcpService, PROTOCOL_VERSION } from '../mcp/server.mjs';

export const DOCTOR_USAGE = 'node src/onboarding/doctor.mjs\nRuns bounded synthetic QR and disabled loopback MCP checks. No credentials, login, tunnel or real messaging.\n';

export async function runDoctor() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 13) throw new Error('NODE_UNSUPPORTED');
  const { default: QRCode } = await import('qrcode');
  const png = await QRCode.toBuffer('https://example.invalid/dots-wechat-doctor-synthetic-only', { type: 'png', width: 512 });
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('QR_RENDERER_FAILED');
  const service = await startLocalMcpService({ port: 0, durationMs: 10000 });
  let closed = false;
  const url = service.address.url;
  const request = async (method, params = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      signal: AbortSignal.timeout(3000)
    });
    if (response.status !== 200) throw new Error('MCP_HTTP_FAILED');
    const message = await response.json();
    if (message.error || !message.result) throw new Error('MCP_RESULT_FAILED');
    return message.result;
  };
  try {
    const response = await fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(3000) });
    if (response.status !== 200) throw new Error('HEALTH_HTTP_FAILED');
    const health = await response.json();
    if (health.liveEnabled !== false || health.configured !== false || health.automaticPolling !== false || health.existingDot !== 'not_verified' || health.service !== 'dots-wechat-local') throw new Error('DISABLED_HEALTH_FAILED');
    const discovery = await request('server/discover');
    if (!discovery.supportedVersions?.includes(PROTOCOL_VERSION)) throw new Error('PROTOCOL_DISCOVERY_FAILED');
    const tools = await request('tools/list');
    if (!['weixin.deliver_owner_reply', 'weixin.get_message_status'].every(name => tools.tools?.some(tool => tool.name === name))) throw new Error('TOOL_DISCOVERY_FAILED');
    const events = await request('events/list');
    if (!events.events?.some(event => event.name === 'weixin.owner_message')) throw new Error('EVENT_DISCOVERY_FAILED');
    const denied = await request('tools/call', { name: 'weixin.get_message_status', arguments: { request_id: 'synthetic-doctor-unavailable' } });
    if (denied.isError !== true || denied.structuredContent?.code !== 'BACKEND_NOT_CONFIGURED') throw new Error('PROTECTED_OPERATION_NOT_DENIED');
    await service.close();
    closed = true;
    let reachable = false;
    try { await fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(500) }); reachable = true; } catch {}
    if (reachable) throw new Error('LISTENER_NOT_CLOSED');
    return { status: 'SELF_CHECK_PASSED', node: process.versions.node, protocolVersion: PROTOCOL_VERSION, service: 'dots-wechat-local', network: 'LOOPBACK_ONLY', qr: 'SYNTHETIC_IN_MEMORY', credentialsRead: false, realBindingRequested: false, realMessagingEnabled: false, existingDot: 'not_verified', checks: ['NODE_SUPPORTED', 'QR_RENDERER', 'DISABLED_HEALTH', 'MCP_DISCOVERY', 'PROTECTED_OPERATION_DENIED', 'CLEAN_SHUTDOWN'] };
  } finally {
    if (!closed) await service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) process.stdout.write(DOCTOR_USAGE);
  else if (args.length) { process.stderr.write('{"status":"SELF_CHECK_FAILED","code":"INVALID_ARGUMENTS"}\n'); process.exitCode = 2; }
  else {
    try { process.stdout.write(`${JSON.stringify(await runDoctor())}\n`); }
    catch (error) { process.stderr.write(`${JSON.stringify({ status: 'SELF_CHECK_FAILED', code: /^[A-Z_]{1,60}$/.test(error?.message ?? '') ? error.message : 'LOCAL_CHECK_FAILED', credentialsRead: false, existingDot: 'not_verified' })}\n`); process.exitCode = 1; }
  }
}

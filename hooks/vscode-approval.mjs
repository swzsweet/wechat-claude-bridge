import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionTitle, suppressGenericWaiting } from './bark-notify.mjs';

const notificationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'notifications');
const configFile = join(notificationsDir, 'wechat-config.json');
const receiptDir = join(notificationsDir, 'wechat');

function wlanAddress() {
  return (networkInterfaces().WLAN || []).find((address) =>
    address.family === 'IPv4' && !address.internal)?.address || null;
}

export function permissionDecision(allow, reason = '已在微信拒绝') {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message: reason }
    }
  };
}

export async function requestWeChatApproval(input, {
  fetcher = fetch, read = readFile, address = wlanAddress,
  suppress = suppressGenericWaiting, configPath = configFile
} = {}) {
  if (process.env.WECHAT_BRIDGE_WORKER === '1') return null;
  if (typeof input?.tool_name !== 'string' || !input.tool_name || !input.tool_input ||
      typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) return null;
  const config = JSON.parse(await read(configPath, 'utf8'));
  if (config.enabled === false || !['a', 'b'].includes(config.workerId)) return null;
  let endpoint;
  if (config.gatewayUrl) {
    const url = new URL(config.gatewayUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash)
      throw new Error('WECHAT_GATEWAY_URL_INVALID');
    endpoint = new URL('/local-approval', url).href;
  } else {
    const host = address();
    if (!host) return null;
    endpoint = `http://${host}:8765/local-approval`;
  }
  const token = (await read(join(config.bridgeDataDir, 'bridge-token.txt'), 'utf8')).trim();
  if (token.length < 24) return null;

  await suppress(input, receiptDir, Number(config.dedupeSeconds) || 20).catch(() => {});
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-worker-id': config.workerId,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      tool: input.tool_name,
      input: input.tool_input,
      session: String(input.session_id || '').slice(0, 8),
      sessionTitle: await sessionTitle(input)
    }),
    signal: AbortSignal.timeout(315000)
  });
  if (response.status === 422) return null;
  if (!response.ok) throw new Error(`WECHAT_APPROVAL_HTTP_${response.status}`);
  const result = await response.json();
  if (typeof result.allow !== 'boolean') throw new Error('WECHAT_APPROVAL_INVALID_RESPONSE');
  return permissionDecision(result.allow, result.reason || '已在微信拒绝');
}

async function readInput() {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) return null;
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const decision = await requestWeChatApproval(await readInput());
    if (decision) console.log(JSON.stringify(decision));
  } catch {
    // A disconnected bridge leaves Claude Code's local permission prompt available.
    console.error('WeChat approval unavailable; use the local permission prompt.');
  }
}

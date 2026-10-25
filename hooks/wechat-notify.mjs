import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook } from './bark-notify.mjs';

const notificationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'notifications');
const configFile = join(notificationsDir, 'wechat-config.json');
const receiptDir = join(notificationsDir, 'wechat');

function wlanAddress() {
  return (networkInterfaces().WLAN || []).find((address) =>
    address.family === 'IPv4' && !address.internal)?.address || null;
}

export async function sendWeChat(config, message, {
  fetcher = fetch, readToken = readFile, address = wlanAddress
} = {}) {
  if (!config.bridgeDataDir || !['a', 'b'].includes(config.workerId))
    throw new Error('WECHAT_CONFIG_INVALID');
  let endpoint;
  if (config.gatewayUrl) {
    const url = new URL(config.gatewayUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash)
      throw new Error('WECHAT_GATEWAY_URL_INVALID');
    endpoint = new URL('/result', url).href;
  } else {
    const host = address();
    if (!host) throw new Error('WECHAT_WLAN_UNAVAILABLE');
    endpoint = `http://${host}:8765/result`;
  }
  const token = (await readToken(join(config.bridgeDataDir, 'bridge-token.txt'), 'utf8')).trim();
  if (token.length < 24) throw new Error('WECHAT_BRIDGE_TOKEN_INVALID');
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-worker-id': config.workerId,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ text: `${message.title}\n${message.body}`,
      ...(message.notification ? { notification: message.notification } : {}) }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`WECHAT_BRIDGE_HTTP_${response.status}`);
  return { status: 'accepted' };
}

export async function runWeChatHook(input, mode, { config, send = sendWeChat, folder = receiptDir } = {}) {
  if (process.env.WECHAT_BRIDGE_WORKER === '1') return { status: 'bridge-worker-ignored' };
  config ??= JSON.parse(await readFile(configFile, 'utf8'));
  return runHook(input, mode, { config, send, folder, receiptName: 'wechat-status.jsonl' });
}

async function readInput() {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) return {};
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runWeChatHook(await readInput(), process.argv[2]);
    if (process.argv.includes('--strict')) console.log(JSON.stringify(result));
  } catch {
    if (process.argv.includes('--strict')) {
      console.error('WECHAT_NOTIFICATION_FAILED');
      process.exitCode = 1;
    } else {
      console.error('WeChat notification unavailable; workflow continues.');
    }
  }
}

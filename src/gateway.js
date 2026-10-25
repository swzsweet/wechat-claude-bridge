import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WeChatTextClient } from './wechat.js';
import { GatewayCore } from './gateway-core.js';
import { bridgeToken, equalSecret, readJson, saveJson } from './common.js';

const dataDir = resolve(process.env.BRIDGE_DATA || 'data');
const token = await bridgeToken(dataDir, true);
const host = process.env.BRIDGE_HOST || '127.0.0.1';
const port = Number(process.env.BRIDGE_PORT || 8765);
if (token.length < 24) throw new Error('BRIDGE_TOKEN must contain at least 24 characters');

const stateFile = resolve(dataDir, 'gateway.json');
const credentialFile = resolve(dataDir, 'wechat.json');
const syncFile = resolve(dataDir, 'sync.txt');
const contextFile = resolve(dataDir, 'wechat-context.json');
const state = await readJson(stateFile, { ownerId: null });
const savedContext = await readJson(contextFile, { token: null });
const workerNames = await readJson(resolve(dataDir, 'computer-names.json'), {});
const client = new WeChatTextClient({ credentialFile, cursorFile: syncFile, onMessage: (msg) => core.incoming(msg) });
await client.login();

const pairCode = randomBytes(6).toString('hex').toUpperCase();
if (!state.ownerId) console.log(`From your WeChat, send: /绑定 ${pairCode}`);
const core = new GatewayCore({
  ownerId: state.ownerId,
  initialContext: savedContext.token,
  saveContext: async (context) => saveJson(contextFile, { token: context }),
  workerNames,
  pairCode,
  saveOwner: async (ownerId) => saveJson(stateFile, { ownerId }),
  send: async (message) => {
    if (!core.ownerId) return;
    for (let i = 0; i < message.length; i += 1200) {
      await client.sendText(core.ownerId, message.slice(i, i + 1200), core.currentContext || undefined);
    }
  }
});

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function body(request) {
  let content = '';
  for await (const chunk of request) {
    content += chunk;
    if (content.length > 20000) throw new Error('Body too large');
  }
  return content ? JSON.parse(content) : {};
}

const server = createServer(async (request, response) => {
  if (!equalSecret(token, request.headers.authorization?.replace(/^Bearer /, ''))) return json(response, 401, { error: 'Unauthorized' });
  const worker = request.headers['x-worker-id'];
  if (worker !== 'a' && worker !== 'b') return json(response, 400, { error: 'Invalid worker' });
  try {
    const url = new URL(request.url, `http://${host}:${port}`);
    if (request.method === 'GET' && url.pathname === '/next') return json(response, 200, { event: await core.next(worker, url.searchParams.get('busy') === '1') });
    if (request.method !== 'POST') return json(response, 404, { error: 'Unknown endpoint' });
    const data = await body(request);
    if (url.pathname === '/approval') {
      if (typeof data.tool !== 'string' || !data.input || typeof data.input !== 'object') return json(response, 400, { error: 'Invalid approval' });
      return json(response, 200, await core.requestApproval(worker, data.tool, data.input));
    }
    if (url.pathname === '/local-approval') {
      if (typeof data.tool !== 'string' || data.tool.length > 100 || !data.input || typeof data.input !== 'object' || Array.isArray(data.input))
        return json(response, 400, { error: 'Invalid approval' });
      const session = typeof data.session === 'string' ? data.session.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) : '';
      const approval = await core.requestLocalApproval(worker, data.tool, data.input, session);
      if (approval.error) return json(response, 422, { error: approval.error });
      response.on('close', () => core.cancelLocalApproval(approval.id, '本机会话已关闭'));
      const decision = await approval.decision;
      if (!response.destroyed) return json(response, 200, decision);
      return;
    }
    if (url.pathname === '/cancel') {
      const pending = core.pending.get(data.id);
      if (pending?.worker === worker) core.pending.delete(data.id);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/result') {
      if (typeof data.text !== 'string') return json(response, 400, { error: 'Invalid result' });
      await core.result(worker, data.text.slice(0, 12000));
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: 'Unknown endpoint' });
  } catch (error) {
    console.error('Worker request:', error);
    return json(response, 500, { error: error.message });
  }
});

server.listen(port, host, () => console.log(`Gateway listening on ${host}:${port}`));
await client.start();

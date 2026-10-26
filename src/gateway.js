import { createServer } from 'node:http';
import { resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { WeChatTextClient } from './wechat.js';
import { TelegramTextClient, validTelegramToken } from './telegram.js';
import { GatewayCore } from './gateway-core.js';
import { deliverToChats } from './chat-delivery.js';
import { ReplyOrigins } from './reply-origins.js';
import { bridgeToken, equalSecret, readJson, saveJson, sleep } from './common.js';

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
const savedTasks = await readJson(resolve(dataDir, 'tasks.json'), []);
const origins = new ReplyOrigins({
  entries: await readJson(resolve(dataDir, 'reply-origins.json'), []),
  save: (entries) => saveJson(resolve(dataDir, 'reply-origins.json'), entries)
});
const savedContext = await readJson(contextFile, { token: null });
const workerNames = await readJson(resolve(dataDir, 'computer-names.json'), {});
let telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!telegramToken) {
  try { telegramToken = (await readFile(resolve(dataDir, 'telegram-token.txt'), 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (telegramToken && !validTelegramToken(telegramToken)) {
  console.error('Invalid Telegram bot token; Telegram channel disabled');
  telegramToken = null;
}
const client = new WeChatTextClient({ credentialFile, cursorFile: syncFile, onMessage: (msg) => core.incoming(msg) });
const telegram = telegramToken ? new TelegramTextClient({
  token: telegramToken, cursorFile: resolve(dataDir, 'telegram-offset.txt'), onMessage: (msg) => core.incoming(msg),
  getOwnerId: () => core.telegramOwnerId,
  onCallback: (callback) => {
    if (callback.from_user_id !== core.telegramOwnerId) return '无权操作。';
    if (callback.approval_id) return telegram.ownsApprovalMessage(callback)
      ? core.incoming(callback) : '审批已处理或过期。';
    return telegram.ownsActionMessage(callback) ? core.action(callback) : '按钮已过期。';
  }
}) : null;

const pairCode = randomBytes(6).toString('hex').toUpperCase();
const telegramPairCode = telegram && !state.telegramOwnerId ? randomBytes(6).toString('hex').toUpperCase() : null;
if (!state.ownerId) console.log(`From your WeChat, send: /绑定 ${pairCode}`);
if (telegramPairCode) console.log(`From a private chat with your Telegram bot, send: /bind ${telegramPairCode}`);
const core = new GatewayCore({
  ownerId: state.ownerId,
  telegramOwnerId: state.telegramOwnerId || null,
  initialContext: savedContext.token,
  initialTasks: savedTasks,
  resolveReply: (messageId) => origins.get(messageId),
  saveTasks: async (tasks) => saveJson(resolve(dataDir, 'tasks.json'), tasks),
  saveContext: async (context) => saveJson(contextFile, { token: context }),
  workerNames,
  pairCode,
  telegramPairCode,
  saveOwner: async (ownerId) => saveJson(stateFile, { ownerId, telegramOwnerId: core.telegramOwnerId }),
  saveTelegramOwner: async (telegramOwnerId) => saveJson(stateFile, { ownerId: core.ownerId, telegramOwnerId }),
  onApprovalSettled: async (id) => telegram?.clearApproval(id),
  send: async (message, { approvalId, markdown, telegramMarkdown, progressTaskId, keyboard,
    replyToMessageId, origin } = {}) => {
    const senders = [];
    if (core.ownerId) senders.push(async (text) => {
      for (let i = 0; i < text.length; i += 1200)
        await client.sendText(core.ownerId, text.slice(i, i + 1200), core.currentContext || undefined);
    });
    if (telegram && core.telegramOwnerId) senders.push(async (text) => {
      const ids = progressTaskId
        ? await telegram.sendProgress(core.telegramOwnerId, progressTaskId, text, { replyToMessageId })
        : markdown ? await telegram.sendMarkdown(core.telegramOwnerId, telegramMarkdown || text, text,
          { approvalId, replyToMessageId })
          : await telegram.sendText(core.telegramOwnerId, text, { approvalId, keyboard, replyToMessageId });
      if (origin && ids?.length) await recordOrigin(ids, origin);
    });
    await deliverToChats(message, senders);
  }
});
async function recordOrigin(ids, origin) {
  const task = origin.taskId ? core.tasks.get(origin.taskId) : null;
  const saved = task ? { ...origin, project: task.project, sessionId: task.sessionId, cwd: task.cwd }
    : origin;
  await origins.record(ids, saved)
    .catch((error) => console.error('Reply origin:', error.message));
}
core.receiveMedia = async (media, worker) => {
  if (!telegram || !media.fileId || !['image', 'document'].includes(media.type) || media.size > 10 * 1024 * 1024)
    throw new Error('仅支持 10 MB 以内的图片或文件');
  const bytes = await telegram.download(media.fileId);
  const id = randomBytes(12).toString('hex');
  const dir = resolve(dataDir, 'media');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(resolve(dir, id), bytes, { mode: 0o600 });
  return { id, type: media.type, name: basename(media.name || 'attachment').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100), worker };
};
core.sendFile = async (name, bytes, caption, origin = null) => {
  if (!telegram || !core.telegramOwnerId) return;
  const ids = await telegram.sendDocument(core.telegramOwnerId, name, bytes, caption);
  if (origin && ids?.length) await recordOrigin(ids, origin);
};
await core.tasks.persist();

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function body(request, limit = 20000) {
  let content = '';
  for await (const chunk of request) {
    content += chunk;
    if (content.length > limit) throw new Error('Body too large');
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
    if (request.method === 'GET' && url.pathname === '/media') {
      const task = core.tasks.get(url.searchParams.get('task'));
      if (!task || task.worker !== worker || !task.media || task.media.id !== url.searchParams.get('id'))
        return json(response, 404, { error: 'Media not found' });
      const bytes = await readFile(resolve(dataDir, 'media', task.media.id));
      return json(response, 200, { name: task.media.name, type: task.media.type, data: bytes.toString('base64') });
    }
    if (request.method !== 'POST') return json(response, 404, { error: 'Unknown endpoint' });
    const data = await body(request, url.pathname === '/file-result' ? 15 * 1024 * 1024 :
      url.pathname === '/plan-ready' ? 40000 : 20000);
    if (url.pathname === '/projects') {
      if (!Array.isArray(data.names) || data.names.length > 100 || data.names.some((name) => typeof name !== 'string' || name.length > 100))
        return json(response, 400, { error: 'Invalid projects' });
      await core.projects(worker, data.names, data.active);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/plan-ready') {
      if (typeof data.id !== 'string' || typeof data.plan !== 'string' || data.plan.length > 30000 || typeof data.project !== 'string')
        return json(response, 400, { error: 'Invalid plan' });
      const ok = await core.planReady(worker, data.id, data.plan, data.project,
        typeof data.sessionId === 'string' ? data.sessionId : null);
      return json(response, ok ? 200 : 404, { ok });
    }
    if (url.pathname === '/file-result') {
      if (!telegram || !core.telegramOwnerId || typeof data.data !== 'string' || data.data.length > 14 * 1024 * 1024 ||
          typeof data.name !== 'string' || !/^[^\\/\r\n]{1,100}$/.test(data.name))
        return json(response, 400, { error: 'Invalid file' });
      const bytes = Buffer.from(data.data, 'base64');
      if (bytes.length > 10 * 1024 * 1024) return json(response, 413, { error: 'File too large' });
      await core.sendFile(data.name, bytes, `${core.label(worker)}：${data.name}`);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/approval') {
      if (typeof data.tool !== 'string' || !data.input || typeof data.input !== 'object') return json(response, 400, { error: 'Invalid approval' });
      return json(response, 200, await core.requestApproval(worker, data.tool, data.input));
    }
    if (url.pathname === '/local-approval') {
      if (typeof data.tool !== 'string' || data.tool.length > 100 || !data.input || typeof data.input !== 'object' || Array.isArray(data.input))
        return json(response, 400, { error: 'Invalid approval' });
      const session = typeof data.session === 'string' ? data.session.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) : '';
      const sessionTitle = typeof data.sessionTitle === 'string' && data.sessionTitle.length <= 100
        ? data.sessionTitle : '';
      const approval = await core.requestLocalApproval(worker, data.tool, data.input, session, sessionTitle);
      if (approval.error) return json(response, 422, { error: approval.error });
      response.on('close', () => core.cancelLocalApproval(approval.id, '本机会话已关闭'));
      const decision = await approval.decision;
      if (!response.destroyed) return json(response, 200, decision);
      return;
    }
    if (url.pathname === '/cancel') {
      const pending = core.pending.get(data.id);
      if (pending?.worker === worker) core.cancelApproval(data.id);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/result') {
      if (typeof data.text !== 'string') return json(response, 400, { error: 'Invalid result' });
      const notice = data.notification;
      const formatted = notice && typeof notice === 'object' && !Array.isArray(notice) &&
        typeof notice.title === 'string' && notice.title.length <= 100 &&
        typeof notice.project === 'string' && notice.project.length <= 100 &&
        typeof notice.session === 'string' && notice.session.length <= 50 &&
        (notice.sessionTitle === undefined ||
          (typeof notice.sessionTitle === 'string' && notice.sessionTitle.length <= 100)) &&
        typeof notice.body === 'string' && notice.body.length <= 12000 ? notice : null;
      const origin = formatted && /^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(formatted.sessionId || '') &&
        typeof formatted.cwd === 'string' && formatted.cwd.length <= 1000 &&
        formatted.kind === 'stop' ? { worker, sessionId: formatted.sessionId, cwd: formatted.cwd } : null;
      await core.result(worker, data.text.slice(0, 12000), formatted, null, origin);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/task-progress') {
      if (typeof data.id !== 'string' || typeof data.stage !== 'string') return json(response, 400, { error: 'Invalid progress' });
      const ok = await core.taskProgress(worker, data.id, data.stage, typeof data.project === 'string' ? data.project : null,
        typeof data.sessionId === 'string' ? data.sessionId : null);
      return json(response, ok ? 200 : 404, { ok });
    }
    if (url.pathname === '/task-finish') {
      if (typeof data.id !== 'string' || typeof data.status !== 'string' || typeof data.text !== 'string')
        return json(response, 400, { error: 'Invalid finish' });
      const ok = await core.finishTask(worker, data.id, data.status, data.text.slice(0, 12000),
        typeof data.sessionId === 'string' ? data.sessionId : null);
      return json(response, ok ? 200 : 404, { ok });
    }
    return json(response, 404, { error: 'Unknown endpoint' });
  } catch (error) {
    console.error('Worker request:', error);
    return json(response, 500, { error: error.message });
  }
});

server.listen(port, host, () => console.log(`Gateway listening on ${host}:${port}`));
async function keepWechatRunning() {
  while (true) {
    try {
      await client.login();
      await client.start();
    } catch (error) {
      console.error('WeChat channel:', error.message);
      await sleep(30000);
    }
  }
}

await Promise.all([keepWechatRunning(), ...(telegram ? [telegram.start()] : [])]);

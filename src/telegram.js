import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sleep } from './common.js';

export const validTelegramToken = (token) => /^\d+:[A-Za-z0-9_-]+$/.test(token);

export const telegramCommands = [
  { command: 'a', description: '切换到电脑 A' },
  { command: 'b', description: '切换到电脑 B' },
  { command: 'status', description: '查看两台电脑的在线状态' },
  { command: 'projects', description: '查看项目列表' },
  { command: 'tasks', description: '查看任务并取消或重试' },
  { command: 'cancel', description: '取消任务，后面填写编号' },
  { command: 'retry', description: '重试任务，后面填写编号' },
  { command: 'plan', description: '先制定计划，后面填写需求' },
  { command: 'file', description: '发送项目文件，后面填写相对路径' },
  { command: 'project', description: '切换项目，后面填写项目名' },
  { command: 'new_project', description: '新建项目，后面填写项目名' },
  { command: 'import_project', description: '登记已有项目，后面填写名称和路径' },
  { command: 'import_projects', description: '批量登记项目目录' },
  { command: 'new', description: '下一条任务开启新会话' },
  { command: 'auto', description: '查看自动模式；可加 on 或 off' },
  { command: 'help', description: '查看命令说明' }
];

export function telegramMessage(update) {
  const message = update.message;
  if (message?.chat?.type !== 'private' || message.from?.id !== message.chat.id) return null;
  const photo = message.photo?.at(-1);
  const media = message.document ? { type: 'document', fileId: message.document.file_id,
    name: message.document.file_name, size: message.document.file_size } : photo ?
    { type: 'image', fileId: photo.file_id, name: 'image.jpg', size: photo.file_size } : null;
  if (typeof message.text !== 'string' && !media) return null;
  return {
    channel: 'telegram',
    from_user_id: String(message.from.id),
    message_id: String(update.update_id),
    text: message.text || message.caption || (media?.type === 'image' ? '请先理解这张图片中的需求，并告诉我你的理解。' : '请查看收到的文件。'),
    ...(media ? { media } : {})
  };
}

export function telegramActionCallback(update) {
  const query = update.callback_query;
  if (!/^(?:task:(?:cancel|retry):[A-F0-9]{8}|project:[A-F0-9]{8}|plan:(?:approve|revise|discard):[A-F0-9]{8})$/.test(query?.data || '') ||
      query.message?.chat?.type !== 'private' || query.from?.id !== query.message.chat.id ||
      !Number.isInteger(query.message.message_id)) return null;
  return { channel: 'telegram', from_user_id: String(query.from.id), message_id: String(update.update_id),
    callback_id: query.id, telegram_message_id: query.message.message_id, action: query.data };
}

export function telegramApprovalCallback(update) {
  const query = update.callback_query;
  const match = /^approval:(approve|deny):([A-F0-9]{8})$/.exec(query?.data || '');
  if (!match || query.message?.chat?.type !== 'private' ||
      query.from?.id !== query.message.chat.id || !Number.isInteger(query.message.message_id)) return null;
  return {
    channel: 'telegram', from_user_id: String(query.from.id),
    message_id: String(update.update_id), callback_id: query.id,
    telegram_message_id: query.message.message_id,
    approval_id: match[2], text: `${match[1] === 'approve' ? '批准' : '拒绝'} ${match[2]}`
  };
}

export class TelegramTextClient {
  constructor({ token, cursorFile, onMessage, onCallback = async () => {}, getOwnerId = () => null, request = fetch }) {
    this.token = token;
    this.cursorFile = cursorFile;
    this.onMessage = onMessage;
    this.onCallback = onCallback;
    this.getOwnerId = getOwnerId;
    this.request = request;
    this.approvalMessages = new Map();
    this.actionMessages = new Map();
    this.progressMessages = new Map();
    this.menuConfiguredFor = undefined;
  }

  async call(method, data, timeout = 45000) {
    const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(timeout)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || `HTTP ${response.status}`}`);
    return result.result;
  }

  async sendText(chatId, text, { approvalId, keyboard } = {}) {
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 2000) {
      const data = { chat_id: chatId, text: chars.slice(i, i + 2000).join('') };
      if (approvalId && i + 2000 >= chars.length) data.reply_markup = { inline_keyboard: [[
        { text: '批准', callback_data: `approval:approve:${approvalId}` },
        { text: '拒绝', callback_data: `approval:deny:${approvalId}` }
      ]] };
      else if (keyboard?.length && i + 2000 >= chars.length) data.reply_markup = { inline_keyboard: keyboard };
      const message = await this.call('sendMessage', data);
      if (approvalId) this.approvalMessages.set(approvalId, { chatId, messageId: message.message_id });
      if (keyboard?.length) for (const row of keyboard) for (const button of row)
        this.actionMessages.set(button.callback_data, { chatId, messageId: message.message_id });
      while (this.actionMessages.size > 500) this.actionMessages.delete(this.actionMessages.keys().next().value);
    }
  }

  async sendProgress(chatId, id, text) {
    const previous = this.progressMessages.get(id);
    if (previous) {
      try {
        await this.call('editMessageText', { chat_id: chatId, message_id: previous, text });
        return;
      } catch (error) { console.error('Telegram progress edit:', error.message); }
    }
    const message = await this.call('sendMessage', { chat_id: chatId, text });
    if (message?.message_id) this.progressMessages.set(id, message.message_id);
    if (this.progressMessages.size > 100) this.progressMessages.delete(this.progressMessages.keys().next().value);
  }

  async sendMarkdown(chatId, text, fallbackText = text) {
    const markdown = text.replace(/^([^\n]+：\n\[[^\]\n]+\]) /u, '$1\n\n');
    if (Buffer.byteLength(markdown, 'utf8') > 30000) return this.sendText(chatId, fallbackText);
    try {
      await this.call('sendRichMessage', { chat_id: chatId, rich_message: { markdown } });
    } catch (error) {
      console.error('Telegram Markdown:', error.message);
      await this.sendText(chatId, fallbackText);
    }
  }

  ownsApprovalMessage(callback) {
    const sent = this.approvalMessages.get(callback.approval_id);
    return sent?.chatId === callback.from_user_id && sent.messageId === callback.telegram_message_id;
  }

  ownsActionMessage(callback) {
    const sent = this.actionMessages.get(callback.action);
    return sent?.chatId === callback.from_user_id && sent.messageId === callback.telegram_message_id;
  }

  async sendDocument(chatId, name, bytes, caption = '') {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      if (caption) form.set('caption', caption.slice(0, 900));
      form.set('document', new Blob([bytes]), name);
      try {
        response = await this.request(`https://api.telegram.org/bot${this.token}/sendDocument`,
          { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        await sleep(1500);
      }
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`Telegram sendDocument: ${result.description || response.status}`);
  }

  async download(fileId, maxBytes = 10 * 1024 * 1024) {
    const file = await this.call('getFile', { file_id: fileId });
    if (!file.file_path || file.file_size > maxBytes) throw new Error('文件超过 10 MB 或 Telegram 未提供下载路径');
    const response = await this.request(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
      { signal: AbortSignal.timeout(60000) });
    if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) throw new Error('文件下载失败或超过 10 MB');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('文件超过 10 MB');
    return bytes;
  }

  async clearApproval(id) {
    const sent = this.approvalMessages.get(id);
    if (!sent) return;
    this.approvalMessages.delete(id);
    await this.call('editMessageReplyMarkup', { chat_id: sent.chatId, message_id: sent.messageId,
      reply_markup: { inline_keyboard: [] } });
  }

  async answerCallback(id, text) {
    await this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  async configureMenu(ownerId) {
    await this.call('setMyCommands', { commands: [
      { command: 'bind', description: '绑定微信桥接，后面填写绑定码' }
    ] }, 10000);
    if (!ownerId) return;
    await this.call('setMyCommands', { commands: telegramCommands,
      scope: { type: 'chat', chat_id: ownerId } }, 10000);
    await this.call('setChatMenuButton', { chat_id: ownerId, menu_button: { type: 'commands' } }, 10000);
  }

  async start() {
    let offset = 0;
    try { offset = Number(await readFile(this.cursorFile, 'utf8')) || 0; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let failures = 0;
    while (true) {
      const ownerId = this.getOwnerId();
      if (ownerId !== this.menuConfiguredFor) {
        try {
          await this.configureMenu(ownerId);
          this.menuConfiguredFor = ownerId;
        } catch (error) { console.error('Telegram menu:', error.message); }
      }
      try {
        const updates = await this.call('getUpdates', {
          offset, timeout: 30, allowed_updates: ['message', 'callback_query']
        }, 40000);
        failures = 0;
        for (const update of updates) {
          const nextOffset = update.update_id + 1;
          const message = telegramMessage(update);
          if (message) await this.onMessage(message);
          if (update.callback_query) {
            const callback = telegramApprovalCallback(update) || telegramActionCallback(update);
            let answer = '无效的按钮。';
            if (callback) {
              try { answer = await this.onCallback(callback) || '审批未提交。'; }
              catch (error) {
                console.error('Telegram callback:', error.message);
                answer = '请查看聊天中的审批结果。';
              }
            }
            await this.answerCallback(update.callback_query.id, answer);
          }
          offset = nextOffset;
          await mkdir(dirname(this.cursorFile), { recursive: true });
          await writeFile(this.cursorFile, String(offset), { mode: 0o600 });
        }
      } catch (error) {
        console.error('Telegram poll:', error.message);
        failures++;
        await sleep(Math.min(30000, 2000 * failures));
      }
    }
  }
}

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sleep } from './common.js';

export function telegramMessage(update) {
  const message = update.message;
  if (message?.chat?.type !== 'private' || message.from?.id !== message.chat.id || typeof message.text !== 'string') return null;
  return {
    channel: 'telegram',
    from_user_id: String(message.from.id),
    message_id: String(update.update_id),
    text: message.text
  };
}

export class TelegramTextClient {
  constructor({ token, cursorFile, onMessage, request = fetch }) {
    this.token = token;
    this.cursorFile = cursorFile;
    this.onMessage = onMessage;
    this.request = request;
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

  async sendText(chatId, text) {
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 2000) {
      await this.call('sendMessage', { chat_id: chatId, text: chars.slice(i, i + 2000).join('') });
    }
  }

  async start() {
    let offset = 0;
    try { offset = Number(await readFile(this.cursorFile, 'utf8')) || 0; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let failures = 0;
    while (true) {
      try {
        const updates = await this.call('getUpdates', {
          offset, timeout: 30, allowed_updates: ['message']
        }, 40000);
        failures = 0;
        for (const update of updates) {
          const nextOffset = update.update_id + 1;
          const message = telegramMessage(update);
          if (message) await this.onMessage(message);
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

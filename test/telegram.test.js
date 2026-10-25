import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramTextClient, telegramMessage, validTelegramToken } from '../src/telegram.js';

test('Bot Token format rejects pasted shell commands', () => {
  assert.equal(validTelegramToken('123456:Ab_cd-Ef'), true);
  assert.equal(validTelegramToken('install -o wechatbridge'), false);
  assert.equal(validTelegramToken(''), false);
});

test('Telegram accepts only text from the sender in a private chat', () => {
  const update = { update_id: 17, message: {
    from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/status'
  } };
  assert.deepEqual(telegramMessage(update), {
    channel: 'telegram', from_user_id: '123', message_id: '17', text: '/status'
  });
  assert.equal(telegramMessage({ ...update, message: { ...update.message, chat: { id: -123, type: 'group' } } }), null);
  assert.equal(telegramMessage({ ...update, message: { ...update.message, from: { id: 456 } } }), null);
  assert.equal(telegramMessage({ ...update, message: { ...update.message, text: undefined } }), null);
});

test('Telegram text is split below the sendMessage limit', async () => {
  const calls = [];
  const client = new TelegramTextClient({ token: '123:example', cursorFile: 'unused', onMessage: async () => {},
    request: async (url, options) => {
      calls.push({ url, data: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
  });
  await client.sendText('123', '好'.repeat(4500));
  assert.deepEqual(calls.map(({ data }) => data.text.length), [2000, 2000, 500]);
  assert.ok(calls.every(({ data }) => data.chat_id === '123'));
  assert.ok(calls.every(({ url }) => url.endsWith('/sendMessage')));
});

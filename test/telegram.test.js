import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramTextClient, telegramMessage, telegramApprovalCallback, validTelegramToken } from '../src/telegram.js';

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

test('Telegram approval buttons belong to a private message from the bot', async () => {
  const calls = [];
  const client = new TelegramTextClient({ token: '123:example', cursorFile: 'unused', onMessage: async () => {},
    request: async (url, options) => {
      calls.push({ method: url.split('/').at(-1), data: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
    }
  });
  await client.sendText('123', 'Review this', { approvalId: 'A1B2C3D4' });
  assert.deepEqual(calls[0].data.reply_markup.inline_keyboard[0].map((button) => button.text), ['批准', '拒绝']);
  const update = { update_id: 19, callback_query: { id: 'callback-1', data: 'approval:approve:A1B2C3D4',
    from: { id: 123 }, message: { message_id: 42, chat: { id: 123, type: 'private' } } } };
  const callback = telegramApprovalCallback(update);
  assert.equal(callback.text, '批准 A1B2C3D4');
  assert.equal(client.ownsApprovalMessage(callback), true);
  assert.equal(telegramApprovalCallback({ ...update, callback_query: { ...update.callback_query, from: { id: 456 } } }), null);
  assert.equal(telegramApprovalCallback({ ...update, callback_query: { ...update.callback_query, data: 'approval:approve:INVALID' } }), null);
  assert.equal(client.ownsApprovalMessage({ ...callback, telegram_message_id: 43 }), false);
  await client.clearApproval('A1B2C3D4');
  assert.equal(calls.at(-1).method, 'editMessageReplyMarkup');
  assert.deepEqual(calls.at(-1).data.reply_markup, { inline_keyboard: [] });
  assert.equal(client.ownsApprovalMessage(callback), false);
});

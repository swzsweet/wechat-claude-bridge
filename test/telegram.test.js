import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramTextClient, telegramMessage, telegramApprovalCallback, telegramCommands, validTelegramToken } from '../src/telegram.js';

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

test('Claude Markdown uses Telegram rich messages and falls back if rejected', async () => {
  const calls = [];
  let rejectRich = false;
  const client = new TelegramTextClient({ token: '123:example', cursorFile: 'unused', onMessage: async () => {},
    request: async (url, options) => {
      const method = url.split('/').at(-1);
      calls.push({ method, data: JSON.parse(options.body) });
      if (rejectRich && method === 'sendRichMessage') return {
        ok: false, status: 400, json: async () => ({ ok: false, description: 'unsupported Markdown' })
      };
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
    }
  });
  const markdown = '# Plan\n\n**Important** item\n\n```js\nconsole.log(1)\n```';
  await client.sendMarkdown('123', markdown);
  assert.deepEqual(calls, [{ method: 'sendRichMessage',
    data: { chat_id: '123', rich_message: { markdown } } }]);
  rejectRich = true;
  await client.sendMarkdown('123', markdown);
  assert.deepEqual(calls.slice(1).map(({ method }) => method), ['sendRichMessage', 'sendMessage']);
  assert.equal(calls.at(-1).data.text, markdown);
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

test('Telegram menu exposes only binding before pairing and working commands afterward', async () => {
  const calls = [];
  const client = new TelegramTextClient({ token: '123:example', cursorFile: 'unused', onMessage: async () => {},
    request: async (url, options) => {
      calls.push({ method: url.split('/').at(-1), data: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }
  });
  await client.configureMenu(null);
  assert.deepEqual(calls.map((call) => call.method), ['setMyCommands']);
  assert.deepEqual(calls[0].data.commands.map((command) => command.command), ['bind']);
  calls.length = 0;
  await client.configureMenu('123');
  assert.deepEqual(calls.map((call) => call.method), ['setMyCommands', 'setMyCommands', 'setChatMenuButton']);
  assert.deepEqual(calls[1].data.scope, { type: 'chat', chat_id: '123' });
  assert.deepEqual(calls[1].data.commands, telegramCommands);
  assert.deepEqual(calls[2].data.menu_button, { type: 'commands' });
  assert.ok(telegramCommands.every(({ command }) => /^[a-z0-9_]{1,32}$/.test(command)));
});

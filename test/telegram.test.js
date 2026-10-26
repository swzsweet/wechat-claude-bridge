import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramTextClient, telegramMessage, telegramApprovalCallback, telegramCommands, validTelegramToken } from '../src/telegram.js';
import { normalSizeHeadings } from '../src/telegram-format.js';

test('Telegram headings use bold normal-sized text outside code fences', () => {
  const source = '# 结果\n\n## **已完成** ##\n\n```md\n# 保留代码\n```\n\n~~~md\n## 仍是代码\n~~~';
  assert.equal(normalSizeHeadings(source),
    '**结果**\n\n**已完成**\n\n```md\n# 保留代码\n```\n\n~~~md\n## 仍是代码\n~~~');
});

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

test('Telegram replies carry selected text or rich-message content as bounded context', () => {
  const base = { update_id: 18, message: { message_id: 80, from: { id: 123 },
    chat: { id: 123, type: 'private' }, text: '继续处理',
    reply_to_message: { message_id: 70, chat: { id: 123, type: 'private' }, text: '完整旧回复' },
    quote: { text: '选中的片段' } } };
  assert.equal(telegramMessage(base).telegram_message_id, 80);
  assert.equal(telegramMessage(base).telegram_reply_to_message_id, 70);
  assert.equal(telegramMessage(base).quote, '选中的片段');
  assert.equal(telegramMessage({ ...base, message: { ...base.message,
    reply_to_message: { ...base.message.reply_to_message, from: { id: 999, is_bot: true } }
  } }).telegram_reply_is_bot, true);
  const rich = { ...base, message: { ...base.message, quote: undefined,
    reply_to_message: { message_id: 70, chat: { id: 123, type: 'private' },
      rich_message: { blocks: [{ type: 'section_heading', text: { text: '检查结果' } },
        { type: 'paragraph', text: { text: '测试通过' } }] } } } };
  assert.equal(telegramMessage(rich).quote, '检查结果\n测试通过');
  assert.equal(telegramMessage({ ...base, message: { ...base.message,
    reply_to_message: { ...base.message.reply_to_message, chat: { id: 456 } } } }).quote, undefined);
  assert.match(telegramMessage({ ...base, message: { ...base.message, quote: undefined,
    reply_to_message: { ...base.message.reply_to_message, text: '很'.repeat(1900) } } }).quote,
  /引用内容已截断/);
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

test('Telegram task messages reply to the originating private message', async () => {
  const calls = [];
  const client = new TelegramTextClient({ token: '123:example', cursorFile: 'unused', onMessage: async () => {},
    request: async (url, options) => {
      calls.push({ method: url.split('/').at(-1), data: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
    }
  });
  assert.deepEqual(await client.sendText('123', '排队中', { replyToMessageId: 80 }), [42]);
  assert.deepEqual(await client.sendProgress('123', 'TASK1', '运行中', { replyToMessageId: 80 }), [42]);
  assert.deepEqual(await client.sendProgress('123', 'TASK1', '完成', { replyToMessageId: 80 }), [42]);
  assert.deepEqual(await client.sendMarkdown('123', '# 结果', '结果', { replyToMessageId: 80 }), [42]);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.data.reply_parameters), [
    { message_id: 80, allow_sending_without_reply: true },
    { message_id: 80, allow_sending_without_reply: true }
  ]);
  assert.equal(calls[2].method, 'editMessageText');
  assert.equal(calls[2].data.reply_parameters, undefined);
  assert.deepEqual(calls[3].data.reply_parameters,
    { message_id: 80, allow_sending_without_reply: true });
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
    data: { chat_id: '123', rich_message: { markdown: markdown.replace('# Plan', '**Plan**') } } }]);
  await client.sendMarkdown('123', '家电脑：\n[仓储系统] # 计划\n\n**重点**');
  assert.equal(calls.at(-1).data.rich_message.markdown, '家电脑：\n[仓储系统]\n\n**计划**\n\n**重点**');
  rejectRich = true;
  await client.sendMarkdown('123', markdown);
  assert.deepEqual(calls.slice(2).map(({ method }) => method), ['sendRichMessage', 'sendMessage']);
  assert.equal(calls.at(-1).data.parse_mode, 'HTML');
  assert.match(calls.at(-1).data.text, /<b>Plan<\/b>/);
  assert.match(calls.at(-1).data.text, /<b>Important<\/b>/);
  await client.sendMarkdown('123', '## 结果\n\n**完成**', '结果：完成');
  assert.match(calls.at(-1).data.text, /<b>结果<\/b>/);
});

test('Telegram falls back to plain text if rich and HTML both fail', async () => {
  const calls = [];
  const client = new TelegramTextClient({ token: '123:example', cursorFile: 'unused', onMessage: async () => {},
    request: async (url, options) => {
      const method = url.split('/').at(-1);
      const data = JSON.parse(options.body);
      calls.push({ method, data });
      if (method === 'sendRichMessage' || data.parse_mode === 'HTML')
        return { ok: false, status: 400, json: async () => ({ ok: false, description: 'unsupported' }) };
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 43 } }) };
    } });
  assert.deepEqual(await client.sendMarkdown('123', '**结果**', '结果'), [43]);
  assert.deepEqual(calls.map(({ method }) => method), ['sendRichMessage', 'sendMessage', 'sendMessage']);
  assert.equal(calls.at(-1).data.text, '结果');
  assert.equal(calls.at(-1).data.parse_mode, undefined);
});

test('long Markdown and approval plans keep HTML formatting in later segments', async () => {
  const calls = [];
  let nextId = 40;
  const client = new TelegramTextClient({ token: '123:example', cursorFile: 'unused', onMessage: async () => {},
    request: async (url, options) => {
      const method = url.split('/').at(-1);
      const data = JSON.parse(options.body);
      calls.push({ method, data });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: ++nextId } }) };
    } });
  const longResult = `**结果**\n\n**${'已检查'.repeat(1300)}**`;
  const ids = await client.sendMarkdown('123', longResult, longResult, { replyToMessageId: 80 });
  assert.ok(ids.length > 1);
  assert.ok(calls.every(({ method, data }) => method === 'sendMessage' && data.parse_mode === 'HTML'));
  assert.match(calls[1].data.text, /<b>/);
  assert.deepEqual(calls[0].data.reply_parameters,
    { message_id: 80, allow_sending_without_reply: true });
  assert.equal(calls[1].data.reply_parameters, undefined);

  calls.length = 0;
  const approvalIds = await client.sendMarkdown('123', `**审批**\n\n${'计划内容'.repeat(1300)}`,
    '审批纯文本', { approvalId: 'A1B2C3D4' });
  assert.ok(approvalIds.length > 1);
  assert.ok(calls.every(({ method, data }) => method === 'sendMessage' && data.parse_mode === 'HTML'));
  assert.equal(calls[0].data.reply_markup, undefined);
  assert.equal(calls.at(-1).data.reply_markup.inline_keyboard[0][0].callback_data,
    'approval:approve:A1B2C3D4');
  assert.equal(client.ownsApprovalMessage({ approval_id: 'A1B2C3D4',
    from_user_id: '123', telegram_message_id: approvalIds.at(-1) }), true);
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

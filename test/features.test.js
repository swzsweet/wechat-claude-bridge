import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayCore } from '../src/gateway-core.js';
import { shareableFile } from '../src/file-access.js';
import { TelegramTextClient, telegramActionCallback, telegramMessage } from '../src/telegram.js';

test('plan review queues execution once and accepts revisions', async () => {
  const sent = [];
  const core = new GatewayCore({ ownerId: 'owner', send: async (text, options) => sent.push({ text, options }) });
  await core.incoming({ from_user_id: 'owner', text: '/plan build it' });
  const planEvent = await core.next('a', false);
  assert.equal(planEvent.type, 'plan');
  assert.equal(await core.planReady('a', planEvent.id, '# Plan\nDo it', 'demo'), true);
  assert.equal(core.tasks.get(planEvent.id).status, 'review');
  assert.equal(sent.find((item) => item.options?.keyboard)?.options.keyboard[0][0].callback_data,
    `plan:approve:${planEvent.id}`);
  assert.equal(await core.action({ action: `plan:revise:${planEvent.id}` }), '等待修改意见。');
  await core.incoming({ from_user_id: 'owner', text: 'Please add tests' });
  const revised = await core.next('a', false);
  assert.equal(revised.type, 'plan');
  assert.match(revised.prompt, /Please add tests/);
  assert.equal(core.tasks.get(planEvent.id).status, 'superseded');
  await core.planReady('a', revised.id, '# Revised plan', 'demo');
  assert.match(await core.action({ action: `plan:approve:${revised.id}` }), /执行任务/);
  assert.equal(core.tasks.get(revised.id).status, 'approved');
  assert.equal(await core.action({ action: `plan:approve:${revised.id}` }), '计划已处理或过期。');
  const execution = await core.next('a', false);
  assert.equal(execution.type, 'task');
  assert.match(execution.prompt, /Revised plan/);
});

test('task cancellation skips queued work and retries with a new id', async () => {
  const core = new GatewayCore({ ownerId: 'owner', send: async () => {} });
  const task = await core.submitTask('a', 'work');
  assert.equal(await core.cancelTask(task.id), '已取消。');
  assert.equal(core.queues.a.length, 0);
  assert.match(await core.retryTask(task.id), /已重新排队/);
  assert.equal((await core.next('a', false)).prompt, 'work');
});

test('project buttons use short opaque keys and select the original worker', async () => {
  const sent = [];
  const core = new GatewayCore({ ownerId: 'owner', send: async (text, options) => sent.push({ text, options }) });
  await core.projects('b', ['仓储系统', 'default'], '仓储系统');
  const button = sent[0].options.keyboard[0][0];
  assert.match(button.callback_data, /^project:[A-F0-9]{8}$/);
  assert.match(button.text, /仓储系统/);
  assert.equal(await core.action({ action: button.callback_data }), '已发送项目切换。');
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'select', name: '仓储系统' });
});

test('task finish records completion and sends final Markdown once', async () => {
  const sent = [];
  const core = new GatewayCore({ ownerId: 'owner', send: async (text, options) => sent.push({ text, options }) });
  const task = await core.submitTask('a', 'work');
  await core.next('a', false);
  assert.equal(await core.finishTask('a', task.id, 'completed', '[demo] **done**'), true);
  assert.equal(core.tasks.get(task.id).status, 'completed');
  assert.equal(core.tasks.get(task.id).delivered, true);
  assert.equal(sent.filter((item) => item.options?.markdown).length, 1);
  await core.finishTask('a', task.id, 'completed', '[demo] **done**');
  assert.equal(sent.filter((item) => item.options?.markdown).length, 1);
});

test('Telegram action buttons require the exact private bot message', async () => {
  const client = new TelegramTextClient({ token: '123:test', cursorFile: 'unused', onMessage: async () => {},
    request: async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) }) });
  await client.sendText('123', 'Actions', { keyboard: [[{ text: 'Cancel', callback_data: 'task:cancel:A1B2C3D4' }]] });
  const update = { update_id: 1, callback_query: { id: 'cb', data: 'task:cancel:A1B2C3D4',
    from: { id: 123 }, message: { message_id: 42, chat: { id: 123, type: 'private' } } } };
  const callback = telegramActionCallback(update);
  assert.equal(client.ownsActionMessage(callback), true);
  assert.equal(client.ownsActionMessage({ ...callback, telegram_message_id: 43 }), false);
  assert.equal(telegramActionCallback({ ...update, callback_query: { ...update.callback_query,
    from: { id: 999 } } }), null);
  assert.equal(telegramActionCallback({ ...update, callback_query: { ...update.callback_query,
    data: 'task:cancel:bad' } }), null);
});

test('Telegram photo and document are accepted only from the private owner chat', () => {
  const base = { update_id: 1, message: { from: { id: 123 }, chat: { id: 123, type: 'private' },
    photo: [{ file_id: 'photo', file_size: 100 }] } };
  assert.equal(telegramMessage(base).media.type, 'image');
  assert.equal(telegramMessage({ ...base, message: { ...base.message, document:
    { file_id: 'doc', file_name: 'plan.md', file_size: 100 } } }).media.type, 'document');
  assert.equal(telegramMessage({ ...base, message: { ...base.message, chat: { id: -1, type: 'group' } } }), null);
});

test('Telegram document upload and bounded media download use Bot API', async () => {
  const calls = [];
  const client = new TelegramTextClient({ token: '123:test', cursorFile: 'unused', onMessage: async () => {},
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/getFile')) return { ok: true, json: async () => ({ ok: true,
        result: { file_path: 'documents/test.txt', file_size: 3 } }) };
      if (url.includes('/file/bot')) return { ok: true, headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: async () => Buffer.from('abc') };
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    } });
  await client.sendDocument('123', 'plan.md', Buffer.from('# Plan'));
  assert.equal(calls[0].options.body.get('document').name, 'plan.md');
  assert.equal(calls[0].options.body.get('chat_id'), '123');
  assert.equal((await client.download('file')).toString(), 'abc');
  assert.equal(calls[1].url.endsWith('/getFile'), true);
});

test('file sharing blocks traversal, hidden and credential paths, and symlink escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-files-'));
  try {
    const project = join(dir, 'project');
    await mkdir(project);
    await writeFile(join(project, 'report.md'), '# Report');
    await writeFile(join(project, '.env'), 'secret');
    await writeFile(join(dir, 'outside.txt'), 'outside');
    assert.equal(await shareableFile(project, 'report.md'), join(project, 'report.md'));
    await assert.rejects(() => shareableFile(project, '../outside.txt'));
    await assert.rejects(() => shareableFile(project, '.env'));
    await assert.rejects(() => shareableFile(project, 'api-token.txt'));
    try {
      await symlink(join(dir, 'outside.txt'), join(project, 'link.txt'));
      await assert.rejects(() => shareableFile(project, 'link.txt'));
    } catch (error) { if (error.code !== 'EPERM') throw error; }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

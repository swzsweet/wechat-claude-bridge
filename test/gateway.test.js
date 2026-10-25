import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayCore } from '../src/gateway-core.js';
import { withQuotedContext } from '../src/quoted-prompt.js';

function fixture() {
  const sent = [];
  const core = new GatewayCore({ ownerId: 'owner', pairCode: 'PAIR', saveOwner: async () => {}, send: async (text) => sent.push(text), ttlMs: 1000 });
  return { core, sent };
}

test('only bound owner can route work and approve', async () => {
  const { core, sent } = fixture();
  await core.incoming({ from_user_id: 'other', text: '/b delete files' });
  assert.equal(core.queues.b.length, 0);
  await core.incoming({ from_user_id: 'owner', text: '/b inspect files' });
  assert.equal((await core.next('b', false)).prompt, 'inspect files');
  assert.match(sent[0], /电脑 B/);

  const { id } = await core.requestApproval('b', 'Bash', { command: 'npm test' });
  await core.incoming({ from_user_id: 'other', text: `批准 ${id}` });
  assert.equal(core.pending.has(id), true);
  await core.incoming({ from_user_id: 'owner', text: `批准 ${id}` });
  assert.deepEqual(await core.next('b', true), { type: 'decision', id, allow: true, answer: undefined });
  await core.incoming({ from_user_id: 'owner', text: `批准 ${id}` });
  assert.match(sent.at(-1), /不存在或已过期/);
});

test('busy worker receives decision before queued task', async () => {
  const { core } = fixture();
  await core.submitTask('a', 'second');
  const { id } = await core.requestApproval('a', 'Write', { file_path: 'a.txt', content: 'hello' });
  await core.incoming({ from_user_id: 'owner', text: `拒绝 ${id}` });
  assert.equal((await core.next('a', true)).type, 'decision');
  assert.equal((await core.next('a', false)).prompt, 'second');
});

test('overlong approval is denied before sending to WeChat', async () => {
  const { core, sent } = fixture();
  const result = await core.requestApproval('a', 'Write', { content: 'x'.repeat(9000) });
  assert.ok(result.error);
  assert.equal(core.pending.size, 0);
  assert.equal(sent.length, 0);
});

test('VS Code approval waits for the bound owner and resolves only once', async () => {
  const { core, sent } = fixture();
  const { id, decision } = await core.requestLocalApproval('a', 'Bash', { command: 'pwd' }, 'session1');
  assert.match(sent.at(-1), new RegExp(`VS Code · 会话 session1 请求 ${id}`));
  await core.incoming({ from_user_id: 'other', text: `批准 ${id}` });
  assert.equal(core.pending.has(id), true);
  await core.incoming({ from_user_id: 'owner', text: `批准 ${id}` });
  assert.deepEqual(await decision, { allow: true });
  assert.equal(core.pending.has(id), false);
  await core.incoming({ from_user_id: 'owner', text: `批准 ${id}` });
  assert.match(sent.at(-1), /不存在或已过期/);
});

test('VS Code approval rejects answers and handles deny, expiry, and cancellation', async () => {
  const { core, sent } = fixture();
  const first = await core.requestLocalApproval('a', 'Write', { file_path: 'a.txt' });
  await core.incoming({ from_user_id: 'owner', text: `答 ${first.id} 1` });
  assert.match(sent.at(-1), /只接受批准或拒绝/);
  await core.incoming({ from_user_id: 'owner', text: `拒绝 ${first.id}` });
  assert.deepEqual(await first.decision, { allow: false });

  const second = await core.requestLocalApproval('a', 'Bash', { command: 'pwd' });
  core.pending.get(second.id).expires = Date.now() - 1;
  await core.incoming({ from_user_id: 'owner', text: `批准 ${second.id}` });
  assert.deepEqual(await second.decision, { allow: false, reason: '远程审批超时，操作已拒绝' });

  const third = await core.requestLocalApproval('a', 'Bash', { command: 'pwd' });
  assert.equal(core.cancelLocalApproval(third.id), true);
  assert.deepEqual(await third.decision, { allow: false, reason: '本机审批已结束' });
});

test('failed or oversized VS Code approval does not leave a pending decision', async () => {
  const { core } = fixture();
  assert.ok((await core.requestLocalApproval('a', 'Write', { content: 'x'.repeat(9000) })).error);
  const failing = new GatewayCore({ ownerId: 'owner', pairCode: 'PAIR', saveOwner: async () => {},
    send: async () => { throw new Error('offline'); }, ttlMs: 1000 });
  await assert.rejects(() => failing.requestLocalApproval('a', 'Bash', { command: 'pwd' }), /offline/);
  assert.equal(failing.pending.size, 0);
});

test('custom computer name appears in replies while /a remains the route', async () => {
  const sent = [];
  const core = new GatewayCore({
    ownerId: 'owner', pairCode: 'PAIR', saveOwner: async () => {},
    send: async (text) => sent.push(text), workerNames: { a: '家电脑' }
  });
  await core.incoming({ from_user_id: 'owner', text: '/a' });
  assert.equal(sent.at(-1), '已切换到家电脑。');
  await core.incoming({ from_user_id: 'owner', text: '/status' });
  assert.match(sent.at(-1), /当前：家电脑。家电脑 离线，电脑 B 离线。/);
  await core.result('a', '[default] OK');
  assert.equal(sent.at(-1), '家电脑：\n[default] OK');
  const { id } = await core.requestApproval('a', 'Bash', { command: 'pwd' });
  assert.match(sent.at(-1), new RegExp(`^家电脑请求 ${id}`));
});

test('worker result is marked as Markdown for Telegram delivery', async () => {
  const sent = [];
  const core = new GatewayCore({ ownerId: 'owner', send: async (text, options) => sent.push({ text, options }) });
  await core.result('a', '[demo] **done**');
  assert.deepEqual(sent, [{ text: '电脑 A：\n[demo] **done**', options: { markdown: true } }]);
});

test('quoted Telegram request keeps the quote separate and threads task replies', async () => {
  const sent = [];
  const core = new GatewayCore({ telegramOwnerId: '123', send: async (text, options) => sent.push({ text, options }) });
  await core.incoming({ channel: 'telegram', from_user_id: '123', message_id: 'update-1',
    telegram_message_id: 80, text: '继续处理', quote: '之前的结果' });
  const event = await core.next('a', false);
  assert.equal(event.prompt, '继续处理');
  assert.equal(event.quote, '之前的结果');
  assert.equal(core.tasks.get(event.id).replyToMessageId, 80);
  assert.equal(sent[0].options.replyToMessageId, 80);
  await core.finishTask('a', event.id, 'completed', '[demo] 完成');
  assert.equal(sent.at(-1).options.replyToMessageId, 80);
  assert.match(withQuotedContext(event.prompt, event.quote), /之前的结果[\s\S]*用户当前要求：\n继续处理/);
  assert.match(await core.retryTask(event.id), /已重新排队/);
  const retry = await core.next('a', false);
  assert.equal(retry.quote, '之前的结果');
  assert.equal(core.tasks.get(retry.id).replyToMessageId, 80);
  await core.incoming({ channel: 'telegram', from_user_id: '123', message_id: 'update-2',
    telegram_message_id: 81, text: '/status', quote: '忽略这条旧消息' });
  assert.equal(core.queues.a.length, 0);
  assert.equal(withQuotedContext('直接执行', null), '直接执行');
});

test('structured Claude notice has a separate Telegram layout without changing WeChat text', async () => {
  const sent = [];
  const core = new GatewayCore({ ownerId: 'owner', workerNames: { a: '家电脑' },
    send: async (text, options) => sent.push({ text, options }) });
  const body = '# 检查结果\n\n- 已完成测试\n- **尚未部署**';
  const original = `Claude Code · 本轮结果与下一步\n项目：仓储系统 · 会话 841b4c87\n\n${body}`;
  await core.result('a', original, { title: '本轮结果与下一步', project: '仓储系统',
    session: '841b4c87', body });
  assert.equal(sent[0].text, `家电脑：\n${original}`);
  assert.match(sent[0].options.telegramMarkdown,
    /^## 本轮结果与下一步\n\n`家电脑` · `仓储系统` · `Claude Code`\n会话 `841b4c87`/);
  assert.match(sent[0].options.telegramMarkdown, /\n\n# 检查结果\n\n- 已完成测试/);
  assert.ok(!sent[0].options.telegramMarkdown.includes('项目：仓储系统 · 会话'));
});

test('only the bound owner updates the saved WeChat context', async () => {
  const contexts = [];
  const core = new GatewayCore({
    ownerId: 'owner', pairCode: 'PAIR', initialContext: 'previous',
    saveOwner: async () => {}, saveContext: async (token) => contexts.push(token),
    send: async () => {}
  });
  await core.incoming({ from_user_id: 'other', text: '/status', context_token: 'untrusted' });
  assert.equal(core.currentContext, 'previous');
  await core.incoming({ from_user_id: 'owner', text: '/status', context_token: 'current' });
  assert.equal(core.currentContext, 'current');
  assert.deepEqual(contexts, ['current']);
});

test('Telegram binding shares tasks and first approval decision with WeChat', async () => {
  const sent = [];
  const saved = [];
  const core = new GatewayCore({ ownerId: 'wechat-owner', pairCode: 'WECHAT', telegramPairCode: 'TELEGRAM',
    saveOwner: async () => {}, saveTelegramOwner: async (id) => saved.push(id),
    send: async (text) => sent.push(text) });
  const telegram = (from, text, message_id) => core.incoming({
    channel: 'telegram', from_user_id: from, text, message_id
  });

  await telegram('stranger', '/bind WRONG', '1');
  assert.equal(core.telegramOwnerId, null);
  await telegram('tg-owner', '/bind TELEGRAM', '2');
  assert.deepEqual(saved, ['tg-owner']);
  await telegram('stranger', '/b delete files', '3');
  assert.equal(core.queues.b.length, 0);
  await telegram('tg-owner', '/b inspect files', '4');
  assert.match((await core.next('b', false)).id, /^[A-F0-9]{8}$/);
  await core.incoming({ from_user_id: 'wechat-owner', text: '/status', message_id: '4' });
  assert.match(sent.at(-1), /当前：电脑 B/);

  const { id, decision } = await core.requestLocalApproval('b', 'Bash', { command: 'pwd' });
  await telegram('tg-owner', `批准 ${id}`, '5');
  assert.deepEqual(await decision, { allow: true });
  await core.incoming({ from_user_id: 'wechat-owner', text: `拒绝 ${id}` });
  assert.match(sent.at(-1), /不存在或已过期/);

  const workerApproval = await core.requestApproval('b', 'Write', { file_path: 'note.txt', content: 'ok' });
  await core.incoming({ from_user_id: 'wechat-owner', text: `拒绝 ${workerApproval.id}` });
  assert.deepEqual(await core.next('b', true), {
    type: 'decision', id: workerApproval.id, allow: false, answer: undefined
  });
  await telegram('tg-owner', `批准 ${workerApproval.id}`, '6');
  assert.match(sent.at(-1), /不存在或已过期/);
});

test('approval buttons use the same one-time decision as text on both channels', async () => {
  const sent = [];
  const settled = [];
  const core = new GatewayCore({ ownerId: 'wechat-owner', telegramOwnerId: 'tg-owner',
    send: async (text, options) => sent.push({ text, options }),
    onApprovalSettled: async (id) => settled.push(id) });
  const first = await core.requestApproval('a', 'Bash', { command: 'pwd' });
  assert.equal(sent.at(-1).options.approvalId, first.id);
  const result = await core.incoming({ channel: 'telegram', from_user_id: 'tg-owner',
    message_id: '100', text: `批准 ${first.id}` });
  assert.equal(result, '已批准。');
  assert.deepEqual(await core.next('a', true), { type: 'decision', id: first.id, allow: true, answer: undefined });
  await core.incoming({ from_user_id: 'wechat-owner', text: `拒绝 ${first.id}` });
  assert.match(sent.at(-1).text, /不存在或已过期/);

  const second = await core.requestLocalApproval('a', 'Write', { file_path: 'note.txt' });
  assert.equal(sent.at(-1).options.approvalId, second.id);
  await core.incoming({ from_user_id: 'wechat-owner', text: `拒绝 ${second.id}` });
  assert.deepEqual(await second.decision, { allow: false });
  assert.equal(await core.incoming({ channel: 'telegram', from_user_id: 'tg-owner',
    message_id: '101', text: `批准 ${second.id}` }), '审批已处理或过期。');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settled, [first.id, second.id]);

  const question = await core.requestApproval('a', 'AskUserQuestion', { questions: [] });
  assert.equal(sent.at(-1).options.approvalId, undefined);
  core.cancelApproval(question.id);
});

test('project commands are routed to the selected computer', async () => {
  const { core } = fixture();
  await core.incoming({ from_user_id: 'owner', text: '/b /new-project demo' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'create', name: 'demo' });
  await core.incoming({ from_user_id: 'owner', text: '/projects' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'list' });
  await core.incoming({ from_user_id: 'owner', text: '/project demo' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'select', name: 'demo' });
});

test('Telegram menu commands have working handlers while old project commands remain valid', async () => {
  const { core, sent } = fixture();
  await core.incoming({ from_user_id: 'owner', text: '/help' });
  assert.match(sent.at(-1), /\/import_projects/);
  await core.incoming({ from_user_id: 'owner', text: '/new_project' });
  assert.match(sent.at(-1), /项目名/);
  await core.incoming({ from_user_id: 'owner', text: '/new_project demo' });
  assert.deepEqual(await core.next('a', false), { type: 'project', action: 'create', name: 'demo' });
  await core.incoming({ from_user_id: 'owner', text: '/import_project demo C:\\Work\\demo' });
  assert.deepEqual(await core.next('a', false), { type: 'project', action: 'import', name: 'demo', path: 'C:\\Work\\demo' });
  await core.incoming({ from_user_id: 'owner', text: '/project' });
  assert.deepEqual(await core.next('a', false), { type: 'project', action: 'list' });
  await core.incoming({ from_user_id: 'owner', text: '/import_projects' });
  assert.match(sent.at(-1), /下一条消息/);
  await core.incoming({ from_user_id: 'owner', text: '取消' });
  await core.incoming({ from_user_id: 'owner', text: '/new-project legacy' });
  assert.deepEqual(await core.next('a', false), { type: 'project', action: 'create', name: 'legacy' });
});

test('auto mode commands route to the selected worker', async () => {
  const { core } = fixture();
  await core.incoming({ from_user_id: 'owner', text: '/b /auto on' });
  assert.deepEqual(await core.next('b', false), { type: 'auto', action: 'on' });
  await core.incoming({ from_user_id: 'owner', text: '/auto' });
  assert.deepEqual(await core.next('b', false), { type: 'auto', action: 'status' });
  await core.incoming({ from_user_id: 'owner', text: '自动模式 关闭' });
  assert.deepEqual(await core.next('b', false), { type: 'auto', action: 'off' });
});

test('two-step bulk registration uses the selected worker and preserves the list', async () => {
  const { core, sent } = fixture();
  await core.incoming({ from_user_id: 'owner', text: '/b 登记项目' });
  assert.match(sent.at(-1), /下一条消息/);
  await core.incoming({ from_user_id: 'owner', text: '网站 = C:\\Work\\site\n数据 = D:\\Work\\data' });
  assert.deepEqual(await core.next('b', false), {
    type: 'project', action: 'bulk', list: '网站 = C:\\Work\\site\n数据 = D:\\Work\\data'
  });
  await core.incoming({ from_user_id: 'owner', text: '切换到网站' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'select', name: '网站' });
});

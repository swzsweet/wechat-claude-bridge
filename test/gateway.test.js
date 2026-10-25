import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayCore } from '../src/gateway-core.js';

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
  core.enqueue('a', { type: 'task', prompt: 'second' });
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
  assert.deepEqual(await second.decision, { allow: false, reason: '微信审批超时，操作已拒绝' });

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

test('project commands are routed to the selected computer', async () => {
  const { core } = fixture();
  await core.incoming({ from_user_id: 'owner', text: '/b /new-project demo' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'create', name: 'demo' });
  await core.incoming({ from_user_id: 'owner', text: '/projects' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'list' });
  await core.incoming({ from_user_id: 'owner', text: '/project demo' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'select', name: 'demo' });
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

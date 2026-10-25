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

test('project commands are routed to the selected computer', async () => {
  const { core } = fixture();
  await core.incoming({ from_user_id: 'owner', text: '/b /new-project demo' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'create', name: 'demo' });
  await core.incoming({ from_user_id: 'owner', text: '/projects' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'list' });
  await core.incoming({ from_user_id: 'owner', text: '/project demo' });
  assert.deepEqual(await core.next('b', false), { type: 'project', action: 'select', name: 'demo' });
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

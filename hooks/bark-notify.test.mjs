import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classify, notification, readable, runHook, sendBark, sessionTitle } from './bark-notify.mjs';

const config = { enabled: true, server: 'https://api.day.app', deviceKey: 'SyntheticDevice123', dedupeSeconds: 20 };
async function folder(t) {
  const path = await mkdtemp(join(tmpdir(), 'bark-hook-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('classifies permission requests, questions, plan approvals, notifications and stop failures', () => {
  assert.equal(classify({}, 'approval'), 'approval');
  assert.equal(classify({}, 'attention'), 'attention');
  assert.equal(classify({ tool_name: 'AskUserQuestion' }, 'question'), 'question');
  assert.equal(classify({ tool_name: 'functions.ExitPlanMode' }, 'question'), 'plan');
  assert.equal(classify({ tool_name: 'Bash' }, 'question'), null);
  assert.equal(classify({ notification_type: 'permission_prompt' }, 'notice'), 'approval');
  assert.equal(classify({ notification_type: 'elicitation_dialog' }, 'notice'), 'question');
  assert.equal(classify({ notification_type: 'idle_prompt' }, 'notice'), null);
  assert.equal(classify({ stop_hook_active: true }, 'stop'), null);
  assert.equal(classify({}, 'stop'), 'stop');
  assert.equal(classify({}, 'failure'), 'failure');
});

test('approval explains the actual action without sending raw commands or unrelated arguments', () => {
  const input = { cwd: 'C:/private/other-project', session_id: 'abc12345-session', tool_name: 'Bash', tool_input: { description: '运行完整测试，确认可以上传代码', password: 'DoNotSendSecret123', command: 'secret command' }, last_assistant_message: 'Unrelated conversation' };
  const message = notification(input, 'approval');
  assert.match(message.body, /other-project.*abc12345/);
  assert.match(message.body, /运行完整测试，确认可以上传代码/);
  assert.match(message.body, /选择允许或拒绝/);
  for (const secret of ['DoNotSendSecret123', 'secret command', 'Unrelated conversation', 'C:/private']) assert.ok(!JSON.stringify(message).includes(secret));
});

test('question includes the real question and choices, not previews or arbitrary input fields', () => {
  const body = notification({ tool_input: { questions: [{ question: '这次是否允许升级数据库权限？', multiSelect: false, options: [{ label: '同意', description: '备份后升级', preview: 'private preview' }, { label: '暂不升级' }] }], secret: 'DoNotSend' } }, 'question').body;
  assert.match(body, /这次是否允许升级数据库权限/);
  assert.match(body, /1\. 同意：备份后升级/);
  assert.match(body, /2\. 暂不升级/);
  assert.ok(!body.includes('private preview')); assert.ok(!body.includes('DoNotSend'));
});

test('completion forwards the real result and remaining work without inventing success', () => {
  const body = notification({ last_assistant_message: '**测试未通过**：结算模块还有1项失败。\n尚未上传；请暂时不要更新服务器。' }, 'stop').body;
  assert.match(body, /测试未通过/); assert.match(body, /尚未上传/); assert.match(body, /请暂时不要更新服务器/);
  assert.ok(!body.includes('请查看最新回复和处理结果'));
  assert.match(notification({}, 'stop').body, /无法判断任务是否完成/);
});

test('completion preserves Markdown structure for Telegram while redacting secrets', () => {
  const notice = notification({ cwd: 'C:/projects/仓储系统', session_id: '841b4c87-long',
    last_assistant_message: '# 检查结果\n\n- **测试通过**\n- token=do-not-send' }, 'stop');
  assert.equal(notice.notification.title, '本轮结果与下一步');
  assert.equal(notice.notification.project, '仓储系统');
  assert.equal(notice.notification.session, '841b4c87');
  assert.match(notice.notification.body, /# 检查结果\n\n- \*\*测试通过\*\*/);
  assert.match(notice.body, /检查结果\n\n- 测试通过/);
  assert.ok(!notice.body.includes('**'));
  assert.ok(!JSON.stringify(notice).includes('do-not-send'));
});

test('reads the latest AI session title only from the matching transcript', async t => {
  const root = await folder(t);
  const project = join(root, 'project');
  await mkdir(project);
  const id = '8cd640ad-bbb8-403a-8f28-9dbe1cafc5c7';
  const transcript_path = join(project, `${id}.jsonl`);
  await writeFile(transcript_path, [
    JSON.stringify({ type: 'ai-title', aiTitle: '旧标题', sessionId: id }),
    'incomplete {',
    JSON.stringify({ type: 'ai-title', aiTitle: '仓储系统检查', sessionId: id }),
    JSON.stringify({ type: 'ai-title', aiTitle: '别的会话', sessionId: 'other' })
  ].join('\n'));
  assert.equal(await sessionTitle({ session_id: id, transcript_path }, root), '仓储系统检查');
  assert.equal(await sessionTitle({ session_id: 'other', transcript_path }, root), '');
  assert.equal(await sessionTitle({ session_id: id, transcript_path }, join(root, 'elsewhere')), '');
  assert.equal(await sessionTitle({ session_title: '指定标题', session_id: id, transcript_path }, root), '指定标题');
});

test('hook forwards a session title as structured notification metadata', async t => {
  const path = await folder(t);
  let sent;
  await runHook({ session_id: '8cd640ad-bbb8-403a-8f28-9dbe1cafc5c7', session_title: '仓储系统检查',
    cwd: 'C:/projects/仓储系统', last_assistant_message: '完成' }, 'stop', {
    config, folder: path, send: async (_, message) => { sent = message; return { status: 'accepted' }; }
  });
  assert.equal(sent.notification.sessionTitle, '仓储系统检查');
  assert.equal(sent.notification.session, '8cd640ad');
  assert.match(sent.body, /会话 8cd640ad/);
});

test('redacts common secrets, connection strings, external links and code fences', () => {
  const body = readable('结果 password=hunter222 token:abc123 密码：123456 postgres://user:secret@localhost/db https://api.day.app/DeviceSecret ```sh\nrm -rf /\n``` ghp_12345678901234567890 sk-abcdefghijklmnop');
  for (const secret of ['hunter222', 'abc123', '123456', 'user:secret', 'DeviceSecret', 'rm -rf', 'ghp_12345678901234567890', 'sk-abcdefghijklmnop']) assert.ok(!body.includes(secret), secret);
  assert.match(body, /结果/); assert.match(body, /已隐藏/);
});

test('long results preserve their beginning and explicitly disclose truncation', () => {
  const body = readable('测试未通过。' + '内容'.repeat(2000));
  assert.ok(body.startsWith('测试未通过。')); assert.ok(body.length < 2300);
  assert.match(body, /完整结果请查看会话/);
});

test('uses honest fallbacks when question, plan, operation or error detail is unavailable', () => {
  assert.match(notification({}, 'question').body, /未包含问题正文/);
  assert.match(notification({}, 'plan').body, /方案正文未随审批事件提供/);
  assert.match(notification({}, 'approval').body, /操作详情未随通知提供/);
  assert.match(notification({ error: '连接超时' }, 'failure').body, /连接超时/);
  assert.match(notification({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, 'approval').body, /上传代码到远程仓库/);
  assert.match(notification({ tool_name: 'Bash', tool_input: { command: 'pnpm test' } }, 'approval').body, /运行测试/);
  assert.match(notification({ tool_input: { plan: '先备份，再验证迁移，最后启动服务。' } }, 'plan').body, /先备份，再验证迁移/);
});

test('POSTs the key in JSON, not the URL, and checks both HTTP and Bark status', async () => {
  let captured;
  const fakeFetch = async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ code: 200 }) }; };
  assert.deepEqual(await sendBark(config, notification({ cwd: 'C:/demo' }, 'test'), fakeFetch), { status: 'accepted', code: 200 });
  assert.equal(captured.url, 'https://api.day.app/push');
  assert.equal(captured.options.method, 'POST');
  assert.equal(JSON.parse(captured.options.body).device_key, config.deviceKey);
  assert.ok(!captured.url.includes(config.deviceKey));
  await assert.rejects(sendBark(config, {}, async () => ({ ok: false })), /BARK_HTTP_FAILED/);
  await assert.rejects(sendBark(config, {}, async () => ({ ok: true, json: async () => ({ code: 400 }) })), /BARK_REJECTED/);
  await assert.rejects(sendBark({ ...config, server: 'https://unapproved.example' }, {}, fakeFetch), /BARK_CONFIG_INVALID/);
});

test('suppresses duplicate waiting events across notification and tool hooks', async t => {
  const path = await folder(t); let sent = 0;
  const options = { config, folder: path, send: async () => { sent++; return { status: 'accepted', code: 200 }; } };
  const input = { session_id: 'session-a', cwd: 'C:/demo', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'approval-1' };
  assert.equal((await runHook(input, 'approval', options)).status, 'accepted');
  assert.equal((await runHook(input, 'approval', options)).status, 'deduplicated');
  assert.equal((await runHook({ ...input, notification_type: 'permission_prompt' }, 'notice', options)).status, 'deduplicated');
  assert.equal(sent, 1);
  const receipt = await readFile(join(path, 'bark-status.jsonl'), 'utf8');
  assert.ok(!receipt.includes('session-a')); assert.ok(!receipt.includes(config.deviceKey));
});

test('generic notices cannot swallow detailed prompts and distinct actions are delivered', async t => {
  const path = await folder(t); const messages = [];
  const options = { config, folder: path, send: async (_, message) => { messages.push(message); return { status: 'accepted' }; } };
  await runHook({ session_id: 'priority', notification_type: 'permission_prompt' }, 'notice', options);
  await runHook({ session_id: 'priority', tool_name: 'Bash', tool_use_id: 'first', tool_input: { description: '运行测试' } }, 'approval', options);
  await runHook({ session_id: 'priority', tool_name: 'Bash', tool_use_id: 'second', tool_input: { description: '上传代码' } }, 'approval', options);
  await runHook({ session_id: 'priority', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '现在是否暂停录单？' }] } }, 'question', options);
  assert.equal(messages.length, 4);
  assert.match(messages[1].body, /运行测试/); assert.match(messages[2].body, /上传代码/);
  assert.match(messages[3].body, /现在是否暂停录单/);
});

test('different sessions and distinct completed replies are not suppressed', async t => {
  const path = await folder(t); let sent = 0;
  const options = { config, folder: path, send: async () => { sent++; return { status: 'accepted' }; } };
  await runHook({ session_id: 'one', last_assistant_message: 'result 1' }, 'stop', options);
  await runHook({ session_id: 'one', last_assistant_message: 'result 1' }, 'stop', options);
  await runHook({ session_id: 'one', last_assistant_message: 'result 2' }, 'stop', options);
  await runHook({ session_id: 'two', last_assistant_message: 'result 1' }, 'stop', options);
  assert.equal(sent, 3);
});

test('failed sends do not permanently deduplicate the next attempt', async t => {
  const path = await folder(t); let sent = 0;
  const options = { config, folder: path, send: async () => { if (++sent === 1) throw new Error('network'); return { status: 'accepted' }; } };
  await assert.rejects(runHook({ session_id: 'retry' }, 'approval', options), /network/);
  assert.equal((await runHook({ session_id: 'retry' }, 'approval', options)).status, 'accepted');
});

test('disabled settings do not send and concurrent duplicate hooks claim one notification', async t => {
  const path = await folder(t); let sent = 0;
  const options = { config, folder: path, send: async () => { sent++; return { status: 'accepted' }; } };
  assert.equal((await runHook({}, 'approval', { ...options, config: { ...config, enabled: false } })).status, 'disabled');
  const results = await Promise.all([runHook({ session_id: 'concurrent' }, 'approval', options), runHook({ session_id: 'concurrent' }, 'approval', options)]);
  assert.equal(sent, 1); assert.equal(results.filter(result => result.status === 'accepted').length, 1);
});

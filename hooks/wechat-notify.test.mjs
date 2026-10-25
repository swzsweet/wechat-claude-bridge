import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWeChatHook, sendWeChat } from './wechat-notify.mjs';

const config = { enabled: true, bridgeDataDir: 'C:/bridge/data', workerId: 'a', dedupeSeconds: 20 };

test('sends a formatted notice through the local bridge without exposing its token in the body', async () => {
  let request;
  const result = await sendWeChat(config, { title: 'Claude Code', body: '任务完成' }, {
    address: () => '192.168.31.166',
    readToken: async () => 'synthetic-token-for-bridge-tests',
    fetcher: async (url, options) => {
      request = { url, options };
      return { ok: true };
    }
  });
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(request.url, 'http://192.168.31.166:8765/result');
  assert.equal(request.options.headers['x-worker-id'], 'a');
  assert.match(request.options.headers.authorization, /^Bearer synthetic-token/);
  assert.equal(JSON.parse(request.options.body).text, 'Claude Code\n任务完成');
  assert.ok(!request.options.body.includes('synthetic-token'));
});

test('uses the configured gateway when the bridge runs on the server', async () => {
  let destination;
  await sendWeChat({ ...config, gatewayUrl: 'http://192.168.31.120:8765' },
    { title: 'Claude Code', body: '完成' }, {
      address: () => { throw new Error('Should not inspect local WLAN'); },
      readToken: async () => 'synthetic-token-for-bridge-tests',
      fetcher: async (url) => { destination = url; return { ok: true }; }
    });
  assert.equal(destination, 'http://192.168.31.120:8765/result');
  await assert.rejects(() => sendWeChat({ ...config, gatewayUrl: 'http://user:pass@192.168.31.120:8765' },
    { title: 'Claude Code', body: '完成' }), /WECHAT_GATEWAY_URL_INVALID/);
});

test('passes structured notification fields to the gateway alongside unchanged WeChat text', async () => {
  let payload;
  const notice = { title: '本轮结果与下一步', project: '仓储系统', session: '841b4c87',
    body: '# 检查结果\n\n- **尚未部署**' };
  await sendWeChat(config, { title: 'Claude Code · 本轮结果与下一步',
    body: '项目：仓储系统 · 会话 841b4c87\n\n检查结果', notification: notice }, {
    address: () => '192.168.31.166', readToken: async () => 'synthetic-token-for-bridge-tests',
    fetcher: async (_, options) => { payload = JSON.parse(options.body); return { ok: true }; }
  });
  assert.equal(payload.text, 'Claude Code · 本轮结果与下一步\n项目：仓储系统 · 会话 841b4c87\n\n检查结果');
  assert.deepEqual(payload.notification, notice);
});

test('reuses redaction and deduplication while writing only a WeChat receipt', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'wechat-hook-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const sent = [];
  const options = { config, folder, send: async (_, message) => {
    sent.push(message);
    return { status: 'accepted' };
  } };
  const input = { session_id: 'test-session', cwd: 'C:/project', last_assistant_message: '完成 password=hidden123' };
  assert.equal((await runWeChatHook(input, 'stop', options)).status, 'accepted');
  assert.equal((await runWeChatHook(input, 'stop', options)).status, 'deduplicated');
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].body.includes('hidden123'));
  const receipt = await readFile(join(folder, 'wechat-status.jsonl'), 'utf8');
  assert.match(receipt, /"status":"accepted"/);
});

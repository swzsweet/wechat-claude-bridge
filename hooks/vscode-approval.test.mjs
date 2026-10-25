import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { suppressGenericWaiting } from './bark-notify.mjs';
import { permissionDecision, requestWeChatApproval } from './vscode-approval.mjs';
import { runWeChatHook } from './wechat-notify.mjs';

const input = { tool_name: 'Bash', tool_input: { command: 'pwd' }, session_id: 'session123' };
const config = JSON.stringify({ enabled: true, bridgeDataDir: 'C:/bridge/data', workerId: 'a', dedupeSeconds: 20 });

test('returns the PermissionRequest decision from the bridge', async () => {
  let request;
  const dependencies = {
    read: async (path) => path.endsWith('bridge-token.txt') ? 'synthetic-bridge-token-for-test' : config,
    address: () => '192.168.31.166', suppress: async () => {},
    fetcher: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ allow: true }) };
    }
  };
  assert.deepEqual(await requestWeChatApproval(input, dependencies), permissionDecision(true));
  assert.equal(request.url, 'http://192.168.31.166:8765/local-approval');
  assert.deepEqual(JSON.parse(request.options.body), { tool: 'Bash', input: { command: 'pwd' },
    session: 'session1', sessionTitle: '' });
  assert.ok(!request.options.body.includes('synthetic-bridge-token'));
  dependencies.fetcher = async () => ({ ok: true, json: async () => ({ allow: false }) });
  assert.deepEqual(await requestWeChatApproval(input, dependencies), permissionDecision(false));
});

test('routes VS Code approvals to the configured server gateway', async () => {
  let destination;
  const remoteConfig = JSON.stringify({
    enabled: true, bridgeDataDir: 'C:/bridge/data', workerId: 'a',
    gatewayUrl: 'http://192.168.31.120:8765'
  });
  const result = await requestWeChatApproval(input, {
    read: async (path) => path.endsWith('bridge-token.txt') ? 'synthetic-bridge-token-for-test' : remoteConfig,
    address: () => { throw new Error('Should not inspect local WLAN'); },
    suppress: async () => {},
    fetcher: async (url) => { destination = url; return { ok: true, json: async () => ({ allow: true }) }; }
  });
  assert.deepEqual(result, permissionDecision(true));
  assert.equal(destination, 'http://192.168.31.120:8765/local-approval');
});

test('oversized inputs and missing configuration leave local approval available', async () => {
  const dependencies = {
    read: async (path) => path.endsWith('bridge-token.txt') ? 'synthetic-bridge-token-for-test' : config,
    address: () => '192.168.31.166', suppress: async () => {},
    fetcher: async () => ({ status: 422, ok: false })
  };
  assert.equal(await requestWeChatApproval(input, dependencies), null);
  assert.equal(await requestWeChatApproval({ tool_input: {} }, dependencies), null);
  assert.equal(await requestWeChatApproval(input, { ...dependencies, address: () => null }), null);
});

test('active VS Code approval suppresses its generic notification duplicate', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'wechat-approval-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const event = { session_id: 'same-session', cwd: 'C:/bridge', notification_type: 'permission_prompt' };
  await suppressGenericWaiting(event, folder, 20);
  let calls = 0;
  const result = await runWeChatHook(event, 'notice', {
    folder, config: JSON.parse(config), send: async () => { calls++; return { status: 'accepted' }; }
  });
  assert.deepEqual(result, { status: 'deduplicated' });
  assert.equal(calls, 0);
});

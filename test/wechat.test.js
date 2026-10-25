import test from 'node:test';
import assert from 'node:assert/strict';
import { WeChatTextClient } from '../src/wechat.js';

test('sendText forwards context token and recipient in iLink format', async () => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ ret: 0 }) };
  };
  try {
    const client = new WeChatTextClient({ credentialFile: 'unused', cursorFile: 'unused', onMessage: () => {} });
    client.credentials = { baseUrl: 'https://example.test', token: 'secret', accountId: 'bot' };
    await client.sendText('owner', 'hello', 'context');
    const body = JSON.parse(captured.options.body);
    assert.equal(captured.url, 'https://example.test/ilink/bot/sendmessage');
    assert.equal(captured.options.headers.Authorization, 'Bearer secret');
    assert.equal(body.msg.to_user_id, 'owner');
    assert.equal(body.msg.context_token, 'context');
    assert.equal(body.msg.item_list[0].text_item.text, 'hello');
  } finally { globalThis.fetch = original; }
});

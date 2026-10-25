import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverToChats } from '../src/chat-delivery.js';

test('both chat channels receive the same message', async () => {
  const received = [];
  await deliverToChats('reply', [
    async (text) => received.push(['wechat', text]),
    async (text) => received.push(['telegram', text])
  ]);
  assert.deepEqual(received, [['wechat', 'reply'], ['telegram', 'reply']]);
});

test('one unavailable channel does not block the other', async () => {
  const received = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    await deliverToChats('approval', [
      async () => { throw new Error('offline'); },
      async (text) => received.push(text)
    ]);
    assert.deepEqual(received, ['approval']);
    await assert.rejects(() => deliverToChats('approval', [async () => { throw new Error('offline'); }]),
      /All chat channels failed/);
  } finally {
    console.error = originalError;
  }
});

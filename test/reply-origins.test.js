import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyOrigins } from '../src/reply-origins.js';

test('reply origins survive reload and keep separate messages on the same task', async () => {
  let saved;
  const origins = new ReplyOrigins({ save: async (entries) => { saved = entries; } });
  await origins.record([40, 41], { worker: 'b', taskId: 'A1B2C3D4' });
  const restored = new ReplyOrigins({ entries: saved });
  assert.deepEqual(restored.get(40), { worker: 'b', taskId: 'A1B2C3D4' });
  assert.deepEqual(restored.get(41), { worker: 'b', taskId: 'A1B2C3D4' });
  assert.equal(restored.get(42), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/task-store.js';

test('task store persists transitions and recovers queued work without rerunning active work', async () => {
  const saved = [];
  const store = new TaskStore({ save: async (snapshot) => saved.push(structuredClone(snapshot)) });
  const queued = await store.create({ worker: 'a', prompt: 'inspect' });
  const active = await store.create({ worker: 'b', prompt: 'edit' });
  await store.update(active.id, { status: 'running', stage: '执行中' });
  assert.equal(saved.at(-1).find((task) => task.id === active.id).status, 'running');

  const restored = new TaskStore({ entries: saved.at(-1) });
  assert.deepEqual(restored.recovered().map((task) => task.id), [queued.id]);
  assert.equal(restored.get(active.id).status, 'interrupted');
  assert.match(restored.get(active.id).stage, /检查结果后重试/);
});

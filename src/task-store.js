import { code } from './common.js';

const MAX_HISTORY = 100;
const ACTIVE = new Set(['queued', 'running', 'planning', 'revising', 'cancelling', 'review']);

export class TaskStore {
  constructor({ entries = [], save = async () => {} } = {}) {
    this.saveSnapshot = save;
    this.write = Promise.resolve();
    this.items = new Map();
    for (const entry of entries) {
      if (!entry || !/^[A-F0-9]{8}$/.test(entry.id) || !['a', 'b'].includes(entry.worker)) continue;
      const task = { ...entry };
      if (['running', 'planning', 'revising', 'cancelling'].includes(task.status)) {
        task.status = 'interrupted';
        task.stage = '网关重启时正在运行，请检查结果后重试';
        task.updatedAt = Date.now();
      }
      this.items.set(task.id, task);
    }
    this.trim();
  }

  get(id) { return this.items.get(id); }

  list(worker = null) {
    return [...this.items.values()].filter((task) => !worker || task.worker === worker)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  recovered() { return [...this.items.values()].filter((task) => task.status === 'queued'); }

  async create({ worker, kind = 'task', prompt, media = null, project = null }) {
    let id = code();
    while (this.items.has(id)) id = code();
    const now = Date.now();
    const task = { id, worker, kind, prompt, media, project, status: 'queued',
      stage: '排队中', createdAt: now, updatedAt: now };
    this.items.set(id, task);
    this.trim();
    await this.persist();
    return task;
  }

  async update(id, changes) {
    const task = this.items.get(id);
    if (!task) return null;
    Object.assign(task, changes, { updatedAt: Date.now() });
    this.trim();
    await this.persist();
    return task;
  }

  trim() {
    if (this.items.size <= MAX_HISTORY) return;
    const history = this.list().reverse().filter((task) => !ACTIVE.has(task.status));
    for (const task of history) {
      if (this.items.size <= MAX_HISTORY) break;
      this.items.delete(task.id);
    }
  }

  persist() {
    const snapshot = this.list();
    this.write = this.write.catch(() => {}).then(() => this.saveSnapshot(snapshot));
    return this.write;
  }
}

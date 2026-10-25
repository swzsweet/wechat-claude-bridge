const MAX_ORIGINS = 1000;

export class ReplyOrigins {
  constructor({ entries = [], save = async () => {} } = {}) {
    this.entries = new Map();
    this.save = save;
    this.write = Promise.resolve();
    for (const entry of entries) {
      if (Number.isSafeInteger(entry?.messageId) && entry.messageId > 0 &&
          ['a', 'b'].includes(entry.origin?.worker) &&
          (entry.origin.taskId || entry.origin.sessionId))
        this.entries.set(entry.messageId, entry.origin);
    }
    this.trim();
  }

  get(messageId) { return this.entries.get(messageId) || null; }

  async record(messageIds, origin) {
    if (!origin || !['a', 'b'].includes(origin.worker)) return;
    for (const messageId of messageIds || []) {
      if (Number.isSafeInteger(messageId) && messageId > 0)
        this.entries.set(messageId, origin);
    }
    this.trim();
    const snapshot = [...this.entries].map(([messageId, value]) => ({ messageId, origin: value }));
    this.write = this.write.catch(() => {}).then(() => this.save(snapshot));
    await this.write;
  }

  trim() {
    while (this.entries.size > MAX_ORIGINS) this.entries.delete(this.entries.keys().next().value);
  }
}

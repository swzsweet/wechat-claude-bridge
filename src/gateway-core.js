import { code, describeRequest, parseCommand } from './common.js';

export class GatewayCore {
  constructor({ send, saveOwner, ownerId = null, pairCode, ttlMs = 300000 }) {
    this.send = send;
    this.saveOwner = saveOwner;
    this.ownerId = ownerId;
    this.pairCode = pairCode;
    this.ttlMs = ttlMs;
    this.route = 'a';
    this.queues = { a: [], b: [] };
    this.waiters = { a: null, b: null };
    this.pending = new Map();
    this.online = { a: 0, b: 0 };
    this.currentContext = null;
    this.seen = new Set();
    this.awaitingProjects = null;
  }

  async incoming(msg) {
    const from = msg.from_user_id;
    const text = msg.text?.trim();
    if (!from || !text) return;
    const dedupe = msg.message_id;
    if (dedupe && this.seen.has(dedupe)) return;
    if (dedupe) {
      this.seen.add(dedupe);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    }
    this.currentContext = msg.context_token || this.currentContext;
    if (!this.ownerId) {
      if (text !== `/绑定 ${this.pairCode}`) return;
      this.ownerId = from;
      await this.saveOwner(from);
      await this.send('绑定成功。发送 /a 或 /b 选择电脑，/status 查看连接。');
      return;
    }
    if (from !== this.ownerId) return;
    let command = parseCommand(text);
    if (command.type === 'route') {
      this.route = command.worker;
      if (!command.prompt) { await this.send(`已切换到电脑 ${this.route.toUpperCase()}。`); return; }
      command = parseCommand(command.prompt);
    }
    if (command.type === 'decision' || command.type === 'answer') {
      const pending = this.pending.get(command.id);
      if (!pending) { await this.send('审批编号不存在或已过期。'); return; }
      if (pending.expires <= Date.now()) {
        this.pending.delete(command.id);
        await this.send('审批已过期，操作未执行。');
        return;
      }
      if (command.type === 'answer' && pending.tool !== 'AskUserQuestion') {
        await this.send('这条审批不需要回答，请发送批准或拒绝。'); return;
      }
      if (command.type === 'decision' && command.allow && pending.tool === 'AskUserQuestion') {
        await this.send('请用「答 编号 选项序号」回答问题，或拒绝。'); return;
      }
      this.pending.delete(command.id);
      this.enqueue(pending.worker, { type: 'decision', id: command.id, allow: command.allow ?? true, answer: command.answer });
      await this.send(`已提交 ${command.id}。`);
      return;
    }
    if (command.type === 'status') {
      const state = (id) => Date.now() - this.online[id] < 45000 ? '在线' : '离线';
      await this.send(`当前：${this.route.toUpperCase()}。A ${state('a')}，B ${state('b')}。`);
      return;
    }
    let worker = this.route;
    if (this.awaitingProjects && command.type === 'prompt' && this.awaitingProjects.expires > Date.now()) {
      if (command.prompt === '取消' || command.prompt === '/cancel') {
        this.awaitingProjects = null;
        await this.send('已取消批量登记。');
        return;
      }
      worker = this.awaitingProjects.worker;
      this.awaitingProjects = null;
      command = { type: 'project', action: 'bulk', list: command.prompt };
    }
    if (command.type === 'project') {
      if (command.action === 'await-bulk') {
        this.awaitingProjects = { worker, expires: Date.now() + 300000 };
        await this.send('请在下一条消息粘贴项目目录，每行一个。可直接写完整路径，也可写“名称 = 完整路径”。发送“取消”退出。');
        return;
      }
      if (command.action === 'bulk' && command.list.length > 10000) {
        await this.send('项目清单超过 10000 字，请分批发送。');
        return;
      }
      this.enqueue(worker, command);
      await this.send(`已发送项目命令到电脑 ${worker.toUpperCase()}。`);
      return;
    }
    if (command.type === 'new') {
      this.enqueue(worker, { type: 'new' });
      await this.send(`电脑 ${worker.toUpperCase()} 下次将开启新会话。`);
      return;
    }
    const prompt = command.prompt;
    if (!prompt || prompt.length > 4000) { await this.send('消息为空或超过 4000 字。'); return; }
    this.enqueue(worker, { type: 'task', prompt });
    await this.send(`已发送到电脑 ${worker.toUpperCase()}。`);
  }

  enqueue(worker, event) {
    const waiter = this.waiters[worker];
    if (waiter) { this.waiters[worker] = null; waiter(event); }
    else this.queues[worker].push(event);
  }

  async next(worker, busy) {
    this.online[worker] = Date.now();
    const queue = this.queues[worker];
    const index = queue.findIndex((e) => e.type === 'decision' || !busy);
    if (index >= 0) return queue.splice(index, 1)[0];
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters[worker] = null; resolve(null); }, 20000);
      this.waiters[worker] = (event) => {
        clearTimeout(timer);
        if (busy && event.type !== 'decision') { queue.push(event); resolve(null); }
        else resolve(event);
      };
    });
  }

  async requestApproval(worker, tool, input) {
    const detail = describeRequest(tool, input);
    if (!detail) return { error: 'Operation too large to review in WeChat' };
    let id = code();
    while (this.pending.has(id)) id = code();
    this.pending.set(id, { worker, tool, input, expires: Date.now() + this.ttlMs });
    const action = tool === 'AskUserQuestion' ? `答 ${id} 选项序号` : `批准 ${id} / 拒绝 ${id}`;
    try { await this.send(`电脑 ${worker.toUpperCase()} 请求 ${id}\n${detail}\n\n${action}`); }
    catch (error) { this.pending.delete(id); throw error; }
    return { id };
  }

  async result(worker, text) { await this.send(`电脑 ${worker.toUpperCase()}：\n${text}`); }
}

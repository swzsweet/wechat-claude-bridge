import { code, describeRequest, parseCommand } from './common.js';
import { TaskStore } from './task-store.js';
import { formatTelegramApproval, formatTelegramNotification } from './telegram-format.js';
import { createWordDocument, plainDocumentText } from './document-content.js';

export class GatewayCore {
  constructor({ send, saveOwner, saveTelegramOwner = async () => {}, saveContext = async () => {}, ownerId = null,
    telegramOwnerId = null, pairCode, telegramPairCode = null, ttlMs = 300000, workerNames = {}, initialContext = null,
    onApprovalSettled = async () => {}, initialTasks = [], saveTasks = async () => {},
    resolveReply = () => null }) {
    this.send = send;
    this.resolveReply = resolveReply;
    this.onApprovalSettled = onApprovalSettled;
    this.saveOwner = saveOwner;
    this.saveTelegramOwner = saveTelegramOwner;
    this.saveContext = saveContext;
    this.ownerId = ownerId;
    this.telegramOwnerId = telegramOwnerId;
    this.pairCode = pairCode;
    this.telegramPairCode = telegramPairCode;
    this.ttlMs = ttlMs;
    this.workerNames = workerNames;
    this.route = 'a';
    this.queues = { a: [], b: [] };
    this.tasks = new TaskStore({ entries: initialTasks, save: saveTasks });
    for (const task of this.tasks.recovered()) this.queues[task.worker].push({
      type: task.kind === 'plan' ? 'plan' : 'task', id: task.id, prompt: task.prompt,
      media: task.media, project: task.project, quote: task.quote,
      sessionId: task.sessionId, cwd: task.cwd
    });
    this.waiters = { a: null, b: null };
    this.pending = new Map();
    this.online = { a: 0, b: 0 };
    this.currentContext = initialContext;
    this.seen = new Set();
    this.awaitingProjects = null;
    this.projectButtons = new Map();
    this.awaitingRevision = null;
  }

  label(worker) {
    const name = this.workerNames[worker];
    return typeof name === 'string' && name.trim() ? name.trim() : `电脑 ${worker.toUpperCase()}`;
  }

  async incoming(msg) {
    const channel = msg.channel || 'wechat';
    if (channel !== 'wechat' && channel !== 'telegram') return;
    const from = msg.from_user_id;
    const text = msg.text?.trim();
    if (!from || !text) return;
    const dedupe = msg.message_id && `${channel}:${msg.message_id}`;
    if (dedupe && this.seen.has(dedupe)) return;
    if (dedupe) {
      this.seen.add(dedupe);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    }
    if (channel === 'telegram') {
      if (!this.telegramOwnerId) {
        if (!this.telegramPairCode ||
            (text !== `/绑定 ${this.telegramPairCode}` && text !== `/bind ${this.telegramPairCode}`)) return;
        this.telegramOwnerId = from;
        await this.saveTelegramOwner(from);
        await this.send('Telegram 绑定成功。微信和 Telegram 现在共用任务、回复和审批。');
        return;
      }
      if (from !== this.telegramOwnerId) return;
    } else {
      if (!this.ownerId) {
        if (text !== `/绑定 ${this.pairCode}`) return;
        this.ownerId = from;
        await this.saveOwner(from);
        await this.updateContext(msg.context_token);
        await this.send('绑定成功。发送 /a 或 /b 选择电脑，/status 查看连接。');
        return;
      }
      if (from !== this.ownerId) return;
      await this.updateContext(msg.context_token);
    }
    const reply = channel === 'telegram' && msg.telegram_reply_to_message_id
      ? this.replyTarget(this.resolveReply(msg.telegram_reply_to_message_id)) : null;
    if (msg.telegram_reply_is_bot && !reply &&
        (msg.media || ['prompt', 'plan'].includes(parseCommand(text).type))) {
      await this.send('无法确定这条旧消息对应的会话，请引用新的任务结果或 Claude Code 本轮结果通知。');
      return;
    }
    if (msg.media && channel === 'telegram') {
      if (!this.receiveMedia) { await this.send('文件接收暂不可用。'); return; }
      try {
        const worker = reply?.worker || this.route;
        const media = await this.receiveMedia(msg.media, worker);
        await this.submitTask(worker, text, { media, quote: msg.quote,
          project: reply?.project, sessionId: reply?.sessionId, cwd: reply?.cwd,
          replyToMessageId: msg.telegram_message_id });
      } catch (error) { await this.send(`文件接收失败：${error.message}`); }
      return;
    }
    let command = parseCommand(text);
    if (command.type === 'route') {
      this.route = command.worker;
      if (!command.prompt) { await this.send(`已切换到${this.label(this.route)}。`); return; }
      command = parseCommand(command.prompt);
    }
    if (command.type === 'decision' || command.type === 'answer') {
      const pending = this.pending.get(command.id);
      if (!pending) { await this.send('审批编号不存在或已过期。'); return '审批已处理或过期。'; }
      if (pending.expires <= Date.now()) {
        if (pending.kind === 'local') this.cancelLocalApproval(command.id, '远程审批超时，操作已拒绝');
        else this.cancelApproval(command.id);
        await this.send('审批已过期，操作未执行。');
        return '审批已过期。';
      }
      if (pending.kind === 'local') {
        if (command.type === 'answer') {
          await this.send('这条 VS Code 审批只接受批准或拒绝。'); return '请批准或拒绝。';
        }
        this.cancelApproval(command.id);
        pending.resolve({ allow: command.allow });
        await this.send(`已提交 ${command.id}。`);
        return command.allow ? '已批准。' : '已拒绝。';
      }
      if (command.type === 'answer' && pending.tool !== 'AskUserQuestion') {
        await this.send('这条审批不需要回答，请发送批准或拒绝。'); return '请批准或拒绝。';
      }
      if (command.type === 'decision' && command.allow && pending.tool === 'AskUserQuestion') {
        await this.send('请用「答 编号 选项序号」回答问题，或拒绝。'); return '请回答选项或拒绝。';
      }
      this.cancelApproval(command.id);
      this.enqueue(pending.worker, { type: 'decision', id: command.id, allow: command.allow ?? true, answer: command.answer });
      await this.send(`已提交 ${command.id}。`);
      return command.allow === false ? '已拒绝。' : '已批准。';
    }
    if (command.type === 'help') {
      await this.send('命令：/a、/b 切换电脑；/status 查看在线状态；/projects 查看项目；/project 项目名 切换项目；/tasks 查看任务；/cancel 编号 取消；/retry 编号 重试；/plan 需求 制定计划；/file 相对路径 发送项目文件；/export 编号 docx 导出计划或结果；/new_project 项目名 新建项目；/import_project 项目名 完整路径 登记项目；/import_projects 批量登记；/new 新开会话；/auto on、/auto off。图片和文件可直接发送。');
      return;
    }
    if (command.type === 'usage') { await this.send(command.text); return; }
    if (command.type === 'status') {
      const state = (id) => Date.now() - this.online[id] < 45000 ? '在线' : '离线';
      await this.send(`当前：${this.label(this.route)}。${this.label('a')} ${state('a')}，${this.label('b')} ${state('b')}。`);
      return;
    }
    if (command.type === 'tasks') { await this.showTasks(); return; }
    if (command.type === 'plan-action') {
      const result = await this.action({ action: `plan:${command.action}:${command.id}` });
      if (result === '计划已处理或过期。' || result.startsWith('已同意')) await this.send(result);
      return;
    }
    if (command.type === 'file') {
      this.enqueue(this.route, { type: 'file', path: command.path });
      await this.send(`已请${this.label(this.route)}发送文件。`);
      return;
    }
    if (command.type === 'export') {
      await this.send(await this.exportTask(command.id, command.format));
      return;
    }
    if (command.type === 'task-action') {
      if (command.action === 'cancel') await this.cancelTask(command.id);
      else await this.retryTask(command.id);
      return;
    }
    if (command.type === 'auto') {
      this.enqueue(this.route, command);
      await this.send(`已发送自动模式命令到${this.label(this.route)}。`);
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
      await this.send(`已发送项目命令到${this.label(worker)}。`);
      return;
    }
    if (command.type === 'new') {
      this.enqueue(worker, { type: 'new' });
      await this.send(`${this.label(worker)}下次将开启新会话。`);
      return;
    }
    if (this.awaitingRevision && command.type === 'prompt') {
      const previous = this.tasks.get(this.awaitingRevision.id);
      const current = this.awaitingRevision.expires > Date.now();
      this.awaitingRevision = null;
      if (current && previous?.status === 'review') {
        await this.tasks.update(previous.id, { status: 'superseded', stage: '正在根据意见修订' });
        await this.submitTask(previous.worker, `${previous.prompt}\n\n请根据以下意见修改计划：\n${command.prompt}`,
          { kind: 'plan', project: previous.project, quote: msg.quote,
            sessionId: previous.sessionId, cwd: previous.cwd,
            replyToMessageId: msg.telegram_message_id });
        return;
      }
    }
    const prompt = command.prompt;
    if (!prompt || prompt.length > 4000) { await this.send('消息为空或超过 4000 字。'); return; }
    const target = command.type === 'prompt' || command.type === 'plan' ? reply : null;
    await this.submitTask(target?.worker || worker, prompt, { kind: command.type === 'plan' ? 'plan' : 'task',
      project: target?.project, sessionId: target?.sessionId, cwd: target?.cwd,
      quote: msg.quote, replyToMessageId: msg.telegram_message_id });
  }

  replyTarget(origin) {
    if (!origin) return null;
    if (origin.taskId) {
      const task = this.tasks.get(origin.taskId);
      return task ? { worker: task.worker, project: task.project, sessionId: task.sessionId,
        cwd: task.cwd } : origin.sessionId ? origin : null;
    }
    return origin;
  }

  async updateContext(token) {
    if (!token || token === this.currentContext) return;
    this.currentContext = token;
    await this.saveContext(token);
  }

  enqueue(worker, event) {
    const waiter = this.waiters[worker];
    if (waiter) { this.waiters[worker] = null; waiter(event); }
    else this.queues[worker].push(event);
  }

  async submitTask(worker, prompt, { kind = 'task', media = null, project = null,
    quote = null, replyToMessageId = null, sessionId = null, cwd = null } = {}) {
    const task = await this.tasks.create({ worker, kind, prompt, media, project, quote, replyToMessageId,
      sessionId, cwd });
    this.enqueue(worker, { type: kind === 'plan' ? 'plan' : 'task', id: task.id, prompt, media, project,
      quote, sessionId, cwd });
    await this.send(`${this.label(worker)} 任务 ${task.id}：排队中。`, {
      progressTaskId: task.id, replyToMessageId, origin: { worker, taskId: task.id } });
    return task;
  }

  async showTasks() {
    const tasks = this.tasks.list().slice(0, 10);
    const labels = { queued: '排队', running: '运行中', planning: '制定计划', review: '待审阅',
      cancelling: '停止中', completed: '已完成', failed: '失败', cancelled: '已取消',
      interrupted: '中断', approved: '已同意', superseded: '已修订' };
    const lines = tasks.map((task) => `${task.id} ${this.label(task.worker)} [${task.project || '当前项目'}] ${labels[task.status] || task.status}：${task.stage}`);
    const keyboard = tasks.slice(0, 5).flatMap((task) => {
      if (task.status === 'review' && task.kind === 'plan') return [[
        { text: `同意 ${task.id}`, callback_data: `plan:approve:${task.id}` },
        { text: '修改', callback_data: `plan:revise:${task.id}` },
        { text: '放弃', callback_data: `plan:discard:${task.id}` }]];
      const action = ['queued', 'running', 'planning', 'revising'].includes(task.status) ? 'cancel'
        : ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status) ? 'retry' : null;
      return action ? [[{ text: `${action === 'cancel' ? '取消' : '重试'} ${task.id}`, callback_data: `task:${action}:${task.id}` }]] : [];
    });
    await this.send(lines.length ? `最近任务：\n${lines.join('\n')}` : '暂无任务。', { keyboard });
  }

  async cancelTask(id) {
    const task = this.tasks.get(id);
    if (!task) { await this.send('任务编号不存在。'); return '任务不存在。'; }
    if (task.status === 'queued') {
      this.queues[task.worker] = this.queues[task.worker].filter((event) => event.id !== id);
      await this.tasks.update(id, { status: 'cancelled', stage: '已从队列移除' });
      await this.send(`任务 ${id} 已取消。`, { progressTaskId: id });
      return '已取消。';
    }
    if (['running', 'planning', 'revising'].includes(task.status)) {
      await this.tasks.update(id, { status: 'cancelling', stage: '正在停止' });
      this.enqueue(task.worker, { type: 'cancel-task', id });
      await this.send(`任务 ${id} 正在停止。`, { progressTaskId: id });
      return '正在停止。';
    }
    await this.send(`任务 ${id} 当前为 ${task.status}，无法取消。`);
    return '无法取消。';
  }

  async retryTask(id) {
    const task = this.tasks.get(id);
    if (!task) { await this.send('任务编号不存在。'); return '任务不存在。'; }
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
      await this.send('该任务尚未结束，不能重试。'); return '任务尚未结束。';
    }
    const next = await this.submitTask(task.worker, task.prompt,
      { kind: task.kind, media: task.media, project: task.project, quote: task.quote,
        sessionId: task.sessionId, cwd: task.cwd,
        replyToMessageId: task.replyToMessageId });
    return `已重新排队，编号 ${next.id}。`;
  }

  async action(callback) {
    const [kind, verb, id] = callback.action.split(':');
    if (kind === 'task') return verb === 'cancel' ? this.cancelTask(id) : this.retryTask(id);
    if (kind === 'project') {
      const item = this.projectButtons.get(verb);
      if (!item || item.expires < Date.now()) return '项目按钮已过期，请重新发送 /projects。';
      this.enqueue(item.worker, { type: 'project', action: 'select', name: item.name });
      await this.send(`已发送项目切换到${this.label(item.worker)}：${item.name}。`);
      return '已发送项目切换。';
    }
    if (kind !== 'plan') return '无效按钮。';
    if (verb === 'export') return this.exportTask(id, 'docx');
    const task = this.tasks.get(id);
    if (!task || task.kind !== 'plan' || task.status !== 'review') return '计划已处理或过期。';
    if (verb === 'revise') {
      this.awaitingRevision = { id, expires: Date.now() + 600000 };
      await this.send(`请发送任务 ${id} 的修改意见。`);
      return '等待修改意见。';
    }
    if (verb === 'discard') {
      await this.tasks.update(id, { status: 'cancelled', stage: '计划已放弃' });
      await this.send(`计划 ${id} 已放弃。`);
      return '已放弃。';
    }
    await this.tasks.update(id, { status: 'approved', stage: '计划已同意，执行已排队' });
    const next = await this.submitTask(task.worker,
      `请按已同意的计划执行需求。原需求：\n${task.prompt}\n\n已同意的计划：\n${task.plan}`,
      { project: task.project, sessionId: task.sessionId, cwd: task.cwd,
        replyToMessageId: task.replyToMessageId });
    return `已同意，执行任务 ${next.id}。`;
  }

  async projects(worker, names, active) {
    for (const [key, entry] of this.projectButtons) if (entry.expires < Date.now()) this.projectButtons.delete(key);
    while (this.projectButtons.size > 60) this.projectButtons.delete(this.projectButtons.keys().next().value);
    const keyboard = [];
    for (const name of names.slice(0, 40)) {
      const key = code();
      this.projectButtons.set(key, { worker, name, expires: Date.now() + 600000 });
      keyboard.push([{ text: `${name === active ? '✓ ' : ''}${name}`.slice(0, 60), callback_data: `project:${key}` }]);
    }
    await this.send(`${this.label(worker)}项目：${names.join('、') || '暂无项目'}`, { keyboard });
  }

  async planReady(worker, id, plan, project, sessionId = null) {
    const task = this.tasks.get(id);
    if (!task || task.worker !== worker || task.kind !== 'plan' || task.status !== 'planning') return false;
    await this.tasks.update(id, { status: 'review', stage: '等待审阅', plan: plan.slice(0, 30000), project,
      ...(sessionId ? { sessionId } : {}) });
    await this.send(`${this.label(worker)} [${project}] 计划 ${id}：\n${plan}`, {
      markdown: true, replyToMessageId: task.replyToMessageId, origin: { worker, taskId: id } });
    await this.send(`计划 ${id}：可点击下方按钮审阅；微信可发送 /plan_approve ${id}、/plan_revise ${id} 或 /plan_discard ${id}。`, { keyboard: [[
      { text: '同意计划', callback_data: `plan:approve:${id}` },
      { text: '要求修改', callback_data: `plan:revise:${id}` },
      { text: '放弃', callback_data: `plan:discard:${id}` }
    ], [
      { text: '下载 Word', callback_data: `plan:export:${id}` }
    ]], replyToMessageId: task.replyToMessageId, origin: { worker, taskId: id } });
    if (this.sendFile) await this.sendFile(`${project}-${id}-plan.md`, Buffer.from(plan, 'utf8'),
      `计划 ${id}`, { worker, taskId: id })
      .catch((error) => console.error('Plan document:', error.message));
    return true;
  }

  async exportTask(id, format = 'docx') {
    const task = this.tasks.get(id);
    const content = task?.kind === 'plan' ? task.plan : task?.status === 'completed' ? task.result : null;
    if (!content) return '该任务暂无可导出的计划或结果。';
    if (!this.telegramOwnerId || !this.sendFile) return '文件导出需要先绑定 Telegram Bot。';
    if (!['docx', 'md', 'txt'].includes(format)) return '只支持 docx、md、txt 导出。';
    const project = String(task.project || 'project').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 50);
    const name = `${project}-${id}-${task.kind === 'plan' ? 'plan' : 'result'}.${format}`;
    try {
      const bytes = format === 'docx' ? await createWordDocument(content)
        : Buffer.from(format === 'txt' ? plainDocumentText(content) : content, 'utf8');
      await this.sendFile(name, bytes, `任务 ${id} · ${format.toUpperCase()}`,
        { worker: task.worker, taskId: id });
      return `已发送 ${format.toUpperCase()} 文件到 Telegram。`;
    } catch (error) {
      console.error('Task export:', error.message);
      return '导出失败，请稍后重试。';
    }
  }

  async taskProgress(worker, id, stage, project = null, sessionId = null) {
    const task = this.tasks.get(id);
    if (!task || task.worker !== worker || !['running', 'planning', 'revising', 'cancelling'].includes(task.status)) return false;
    await this.tasks.update(id, { stage: String(stage).slice(0, 160), ...(project ? { project } : {}),
      ...(sessionId ? { sessionId } : {}) });
    await this.send(`${this.label(worker)} 任务 ${id}：${stage}`, {
      progressTaskId: id, replyToMessageId: task.replyToMessageId, origin: { worker, taskId: id } });
    return true;
  }

  async finishTask(worker, id, status, text, sessionId = null) {
    const task = this.tasks.get(id);
    if (!task || task.worker !== worker) return false;
    if (!['completed', 'failed', 'cancelled'].includes(status)) return false;
    if (task.delivered) return true;
    await this.tasks.update(id, { status, result: String(text || '').slice(0, 12000),
      ...(sessionId ? { sessionId } : {}),
      stage: status === 'completed' ? '已完成' : status === 'cancelled' ? '已取消' : '失败' });
    await this.send(`${this.label(worker)} 任务 ${id}：${this.tasks.get(id).stage}`, {
      progressTaskId: id, replyToMessageId: task.replyToMessageId, origin: { worker, taskId: id } });
    if (text) await this.result(worker, text, null, task.replyToMessageId, { worker, taskId: id });
    await this.tasks.update(id, { delivered: true });
    return true;
  }

  cancelApproval(id) {
    if (!this.pending.delete(id)) return false;
    Promise.resolve().then(() => this.onApprovalSettled(id))
      .catch((error) => console.error('Clear Telegram approval:', error.message));
    return true;
  }

  async next(worker, busy) {
    this.online[worker] = Date.now();
    const queue = this.queues[worker];
    const index = queue.findIndex((e) => e.type === 'decision' || e.type === 'cancel-task' || !busy);
    let event;
    if (index >= 0) event = queue.splice(index, 1)[0];
    else event = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters[worker] = null; resolve(null); }, 20000);
      this.waiters[worker] = (event) => {
        clearTimeout(timer);
        if (busy && event.type !== 'decision' && event.type !== 'cancel-task') { queue.push(event); resolve(null); }
        else resolve(event);
      };
    });
    if (event && ['task', 'plan'].includes(event.type)) {
      const task = this.tasks.get(event.id);
      if (task?.status !== 'queued') return null;
      await this.tasks.update(event.id, { status: event.type === 'plan' ? 'planning' : 'running',
        stage: event.type === 'plan' ? '正在制定计划' : '正在执行' });
    }
    return event;
  }

  async requestApproval(worker, tool, input) {
    const detail = describeRequest(tool, input);
    if (!detail) return { error: 'Operation too large to review in chat' };
    let id = code();
    while (this.pending.has(id)) id = code();
    this.pending.set(id, { worker, tool, input, expires: Date.now() + this.ttlMs });
    const action = tool === 'AskUserQuestion' ? `答 ${id} 选项序号` : `批准 ${id} / 拒绝 ${id}`;
    try { await this.send(`${this.label(worker)}请求 ${id}\n${detail}\n\n${action}`,
      { approvalId: tool === 'AskUserQuestion' ? undefined : id, markdown: true,
        telegramMarkdown: formatTelegramApproval(this.label(worker), id, tool, input) }); }
    catch (error) { this.cancelApproval(id); throw error; }
    return { id };
  }

  async requestLocalApproval(worker, tool, input, session = '', sessionTitle = '') {
    const detail = describeRequest(tool, input);
    if (!detail) return { error: 'Operation too large to review in chat' };
    let id = code();
    while (this.pending.has(id)) id = code();
    let resolveDecision;
    const decision = new Promise((resolve) => { resolveDecision = resolve; });
    const timer = setTimeout(() => {
      this.cancelLocalApproval(id, '远程审批超时，操作已拒绝');
    }, this.ttlMs);
    this.pending.set(id, {
      kind: 'local', worker, tool, expires: Date.now() + this.ttlMs,
      resolve: (result) => { clearTimeout(timer); resolveDecision(result); }
    });
    const cleanTitle = String(sessionTitle).replace(/[\r\n\t`\\]/g, ' ').trim().slice(0, 80);
    const context = cleanTitle ? ` · 会话 ${cleanTitle}${session ? ` (${session})` : ''}`
      : session ? ` · 会话 ${session}` : '';
    const label = `${this.label(worker)} VS Code${context}`;
    try {
      await this.send(`${label} 请求 ${id}\n${detail}\n\n批准 ${id} / 拒绝 ${id}`, {
        approvalId: id, markdown: true,
        telegramMarkdown: formatTelegramApproval(label, id, tool, input)
      });
    } catch (error) {
      this.cancelLocalApproval(id, '消息发送失败');
      throw error;
    }
    return { id, decision };
  }

  cancelLocalApproval(id, reason = '本机审批已结束') {
    const pending = this.pending.get(id);
    if (pending?.kind !== 'local') return false;
    this.cancelApproval(id);
    pending.resolve({ allow: false, reason });
    return true;
  }

  async result(worker, text, notification = null, replyToMessageId = null, origin = null) {
    await this.send(`${this.label(worker)}：\n${text}`, {
      markdown: true,
      ...(origin ? { origin } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(notification ? { telegramMarkdown: formatTelegramNotification(this.label(worker), notification) } : {})
    });
  }
}

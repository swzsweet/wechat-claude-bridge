import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const userRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const notifyRoot = join(userRoot, 'notifications');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const waitingKinds = new Set(['approval', 'question', 'plan', 'attention']);

export function classify(input = {}, mode = '') {
  const tool = String(input.tool_name ?? '').split('.').at(-1);
  if (mode === 'test') return 'test';
  if (mode === 'approval') return 'approval';
  if (mode === 'attention') return 'attention';
  if (mode === 'question') {
    if (tool === 'ExitPlanMode') return 'plan';
    return tool === 'AskUserQuestion' ? 'question' : null;
  }
  if (mode === 'notice') {
    const type = input.notification_type;
    return type === 'permission_prompt' ? 'approval' : type === 'elicitation_dialog' ? 'question' : null;
  }
  if (mode === 'stop') return input.stop_hook_active ? null : 'stop';
  if (mode === 'failure') return 'failure';
  return null;
}

export function readable(value, limit = 2200, { preserveMarkdown = false } = {}) {
  const text = String(value ?? '')
    .replace(/```[\s\S]*?```/g, '[代码或命令请在会话中查看]')
    .replace(/https?:\/\/[^\s<>"')]+/gi, '[链接请在会话中查看]')
    .replace(/\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s]+/gi, '[连接信息已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '[密钥已隐藏]')
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|device[_-]?key|authorization|密码|口令|密钥)\s*["']?\s*[:=：]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;，；]+)/gi, '$1[已隐藏]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, (match) => preserveMarkdown ? match : '')
    .replace(/\*\*|__|`/g, (match) => preserveMarkdown ? match : '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  return text.length > limit ? `${text.slice(0, limit)}\n…内容较长，完整结果请查看会话。` : text;
}

function actionDescription(input) {
  const args = input.tool_input || {};
  if (typeof args.description === 'string' && args.description.trim()) return readable(args.description, 600);
  const tool = String(input.tool_name || '').split('.').at(-1);
  const actions = {
    Read: '读取文件', Glob: '查找文件', Grep: '搜索文件内容',
    Write: '写入文件', Edit: '修改文件', NotebookEdit: '修改笔记本',
    WebFetch: '读取网页', WebSearch: '搜索网页',
    SendMessage: '向另一个会话发送消息', PushNotification: '发送手机通知',
    ExitPlanMode: '确认实施方案', AskUserQuestion: '回答问题',
  };
  if (actions[tool]) return actions[tool];
  if (tool === 'Bash' || tool === 'PowerShell') {
    // Classify locally; never forward a raw command or its arguments to Bark.
    const command = String(args.command || '');
    if (/\bgit\s+push\b/i.test(command)) return '上传代码到远程仓库';
    if (/\bgit\s+commit\b/i.test(command)) return '创建代码提交';
    if (/\b(test|vitest|pytest)\b|--test/i.test(command)) return '运行测试，检查改动是否正常';
    if (/\b(build|tsc|typecheck|lint)\b/i.test(command)) return '检查或构建项目';
    if (/\b(install|add)\b/i.test(command)) return '安装项目依赖';
    return '执行本机命令（具体命令请在会话审批框核对）';
  }
  return `使用工具 ${readable(tool || '未知工具', 100)}（具体操作请在会话审批框核对）`;
}

export async function sessionTitle(input, projectsRoot = join(userRoot, 'projects')) {
  const direct = readable(input.session_title, 80).replace(/\s+/g, ' ').trim();
  if (direct) return direct;
  const id = String(input.session_id || '');
  const transcript = String(input.transcript_path || '');
  if (!/^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(id) || !transcript ||
      win32.basename(transcript).toLowerCase() !== `${id.toLowerCase()}.jsonl`) return '';
  try {
    const root = await realpath(projectsRoot);
    const file = await realpath(transcript);
    const pathFromRoot = relative(root, file);
    if (!pathFromRoot || pathFromRoot.startsWith('..') || win32.isAbsolute(pathFromRoot)) return '';
    if ((await stat(file)).size > 64 * 1024 * 1024) return '';
    let title = '';
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length > 16 * 1024 || !line.includes('"type":"ai-title"')) continue;
      try {
        const record = JSON.parse(line);
        if (record.type === 'ai-title' && record.sessionId === id && typeof record.aiTitle === 'string')
          title = readable(record.aiTitle, 80).replace(/\s+/g, ' ').trim();
      } catch { /* Ignore incomplete transcript records. */ }
    }
    return title;
  } catch { return ''; }
}

export function notification(input, kind, resolvedSessionTitle = '') {
  const project = win32.basename(String(input.cwd || process.cwd()).replaceAll('/', '\\'))
    .replace(/[\r\n\t\u0000-\u001f]/g, ' ').slice(0, 60) || '当前项目';
  const session = String(input.session_id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8);
  const origin = `项目：${readable(project, 60)}${session ? ` · 会话 ${session}` : ''}`;
  const args = input.tool_input || {};
  let title, body, markdownBody;
  if (kind === 'approval' || kind === 'attention') {
    title = kind === 'approval' ? '请审批这项操作' : '操作未获允许，需要你决定';
    const action = input.tool_name ? actionDescription(input) : readable(input.message, 600);
    body = `准备做：${action || '当前操作详情未随通知提供，需查看会话审批框。'}\n你需要做：回到对应会话，核对后选择允许或拒绝。手机推送不会代替你授权。`;
  } else if (kind === 'question') {
    title = '请回答这个问题';
    const questions = Array.isArray(args.questions) ? args.questions : [];
    const details = questions.map(q => {
      const options = Array.isArray(q.options) ? q.options.map((o, i) => `${i + 1}. ${o.label || ''}${o.description ? `：${o.description}` : ''}`).join('\n') : '';
      return `${q.question || q.header || ''}${q.multiSelect ? '（可多选）' : ''}${options ? `\n${options}` : ''}`;
    }).join('\n\n');
    body = `${readable(details || input.message, 1800) || '本次通知未包含问题正文，请查看会话。'}\n你需要做：回到对应会话选择答案，或输入你的意见。`;
  } else if (kind === 'plan') {
    title = '请确认实施方案';
    body = `${readable(args.plan || input.last_assistant_message, 1800) || '方案正文未随审批事件提供，请在会话中查看完整方案。'}\n你需要做：确认方案范围后，在会话中批准或提出修改；未批准前不会因推送自动开工。`;
    markdownBody = `${readable(args.plan || input.last_assistant_message, 1800, { preserveMarkdown: true }) || '方案正文未随审批事件提供，请在会话中查看完整方案。'}\n你需要做：确认方案范围后，在会话中批准或提出修改；未批准前不会因推送自动开工。`;
  } else if (kind === 'stop') {
    title = '本轮结果与下一步';
    body = readable(input.last_assistant_message) || '本轮已停止，但没有收到最终回复，无法判断任务是否完成。请查看会话；不要据此开始服务器更新。';
    markdownBody = readable(input.last_assistant_message, 2200, { preserveMarkdown: true }) || body;
  } else if (kind === 'failure') {
    title = '处理被中断，尚未完成';
    body = `${readable(input.error, 800) || '本轮未正常结束，尚无可靠的完成结果。'}\n你需要做：查看会话中的中断原因；不要把本次中断当成测试通过或更新完成。`;
  } else {
    title = '推送内容已改为具体事项';
    body = '以后审批会写明准备做什么、需要你确认什么；提问带上问题和选项；本轮结束直接推送最终回复和下一步。此为通知测试，不代表代码已上传或服务器已更新。';
  }
  return { title: `Claude Code · ${title}`, body: `${origin}\n\n${body}`, group: `Claude Code · ${project}`,
    notification: { title, project: readable(project, 60), session,
      sessionTitle: resolvedSessionTitle, body: markdownBody || body } };
}

export async function sendBark(config, message, fetcher = fetch) {
  if (config.server !== 'https://api.day.app' || !/^[A-Za-z0-9_-]{8,128}$/.test(config.deviceKey ?? ''))
    throw new Error('BARK_CONFIG_INVALID');
  const response = await fetcher(`${config.server}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ device_key: config.deviceKey, title: message.title,
      body: message.body, group: message.group }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('BARK_HTTP_FAILED');
  const result = await response.json();
  if (result.code !== 200) throw new Error('BARK_REJECTED');
  return { status: 'accepted', code: result.code };
}

async function claim(folder, key, ttl) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `${key}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.close();
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await stat(file)).mtimeMs < ttl) return null;
        await unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return null;
}

export async function suppressGenericWaiting(input, folder = notifyRoot, ttlSeconds = 20) {
  const sessionHash = hash(input.session_id || `cwd:${input.cwd || process.cwd()}`).slice(0, 24);
  const key = hash(`${sessionHash}|waiting|`).slice(0, 32);
  await claim(join(folder, 'state'), key, ttlSeconds * 1000);
}

export async function runHook(input, mode, { config, folder = notifyRoot, send = sendBark, receiptName = 'bark-status.jsonl' } = {}) {
  const kind = classify(input, mode);
  if (!kind) return { status: 'ignored' };
  config ??= JSON.parse(await readFile(join(notifyRoot, 'bark-config.json'), 'utf8'));
  if (config.enabled === false) return { status: 'disabled' };
  const sessionHash = hash(input.session_id || `cwd:${input.cwd || process.cwd()}`).slice(0, 24);
  const group = waitingKinds.has(kind) ? 'waiting' : kind;
  const detailedWaiting = waitingKinds.has(kind) && mode !== 'notice' && Boolean(input.tool_name);
  const fingerprint = kind === 'stop' ? hash(input.last_assistant_message || '')
    : detailedWaiting ? hash(JSON.stringify([kind, input.tool_use_id, input.tool_name, input.tool_input?.description, input.tool_input?.questions])) : '';
  const key = hash(`${sessionHash}|${group}|${fingerprint}`).slice(0, 32);
  const ttl = Math.max(5, Math.min(60, Number(config.dedupeSeconds) || 20)) * 1000;
  const lock = kind === 'test' ? null : await claim(join(folder, 'state'), key, ttl);
  if (kind !== 'test' && !lock) return { status: 'deduplicated' };
  try {
    const result = await send(config, notification(input, kind, await sessionTitle(input)));
    if (detailedWaiting) {
      // A later generic notice must not repeat this prompt; an earlier generic
      // notice must never swallow the useful question or a distinct approval.
      const noticeKey = hash(`${sessionHash}|waiting|`).slice(0, 32);
      await claim(join(folder, 'state'), noticeKey, ttl).catch(() => {});
    }
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await appendFile(join(folder, receiptName), JSON.stringify({
        time: new Date().toISOString(), kind,
        event: String(input.hook_event_name || 'manual-test').slice(0, 40),
        sessionHash, status: result.status,
      }) + '\n', { mode: 0o600 });
    } catch { /* A local receipt failure must not turn an accepted push into a duplicate. */ }
    return result;
  } catch (error) {
    if (lock) await unlink(lock).catch(() => {});
    throw error;
  }
}

async function readInput() {
  let bytes = 0, oversized = false;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes <= 128 * 1024) chunks.push(chunk);
    else oversized = true;
  }
  if (oversized) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const strict = process.argv.includes('--strict');
  try {
    const result = await runHook(await readInput(), process.argv[2]);
    if (strict) console.log(JSON.stringify(result));
  } catch {
    // Never expose an endpoint, device key, tool input or provider error stack.
    if (strict) {
      console.error('BARK_NOTIFICATION_FAILED');
      process.exitCode = 1;
    } else {
      console.error('Bark notification unavailable; workflow continues.');
      process.exitCode = 0;
    }
  }
}

import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { bridgeToken, readJson, saveJson, sleep } from './common.js';
import { createProject, findProject, importProjects, parseProjectList, prepareRoot, projectPath, validName } from './projects.js';
import { workerPermissionOptions } from './permission-mode.js';
import { shareableFile } from './file-access.js';

const id = process.env.WORKER_ID?.toLowerCase();
const gateway = process.env.GATEWAY_URL?.replace(/\/$/, '');
const dataDir = resolve(process.env.BRIDGE_DATA || 'data');
const token = await bridgeToken(dataDir);
const data = resolve(dataDir, `worker-${id}.json`);
if (!['a', 'b'].includes(id) || !gateway || !token) throw new Error('Set WORKER_ID and GATEWAY_URL, and configure BRIDGE_TOKEN on remote workers');
if (!/^https?:\/\//.test(gateway)) throw new Error('GATEWAY_URL must be HTTP(S)');
const root = await prepareRoot(resolve(process.env.PROJECTS_ROOT || resolve(homedir(), 'Documents', 'ClaudeProjects')));

async function api(path, payload, method = 'POST') {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-worker-id': id, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(method === 'GET' ? 60000 : path === '/file-result' ? 90000 :
      path === '/task-progress' ? 30000 : 15000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  return result;
}

let state = await readJson(data, null);
if (!state?.projects) {
  await createProject(root, 'default').catch((error) => { if (error.code !== 'EEXIST') throw error; });
  state = { active: 'default', projects: { default: { path: 'default', sessionId: state?.sessionId || process.env.INITIAL_SESSION_ID || null } } };
  await saveJson(data, state);
}
let busy = false;
let activeRun = null;
const decisions = new Map();

async function approve(tool, input) {
  if (tool === 'AskUserQuestion' && (input.questions || []).length !== 1) {
    return { behavior: 'deny', message: 'Multiple questions require local approval' };
  }
  const request = await api('/approval', { tool, input });
  if (request.error) return { behavior: 'deny', message: request.error };
  const id = request.id;
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => { decisions.delete(id); resolve({ allow: false, reason: 'WeChat approval timed out' }); }, 300000);
    decisions.set(id, (value) => { clearTimeout(timer); resolve(value); });
  });
  if (outcome.reason) api('/cancel', { id }).catch(() => {});
  if (!outcome.allow) return { behavior: 'deny', message: outcome.reason || 'Denied in WeChat' };
  if (tool === 'AskUserQuestion') {
    const questions = input.questions || [];
    if (questions.length !== 1) return { behavior: 'deny', message: 'Multiple questions require local approval' };
    const choice = Number(outcome.answer);
    const options = questions[0].options || [];
    if (!Number.isInteger(choice) || choice < 1 || choice > options.length) return { behavior: 'deny', message: 'Invalid option number' };
    return { behavior: 'allow', updatedInput: { ...input, answers: { [questions[0].question]: options[choice - 1].label } } };
  }
  return { behavior: 'allow', updatedInput: input };
}

async function requireRemoteApproval(input) {
  const decision = await approve(input.tool_name, input.tool_input || {});
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.behavior === 'allow' ? 'allow' : 'deny',
      permissionDecisionReason: decision.behavior === 'deny' ? decision.message : 'Approved in WeChat'
    }
  };
}

async function run(event) {
  busy = true;
  const name = event.project || state.active;
  const controller = new AbortController();
  activeRun = { id: event.id, controller };
  let answer = '';
  let executionComplete = false;
  let nextStage = null;
  let reporting = false;
  let progressWrite = Promise.resolve();
  function report(stage) {
    nextStage = stage;
    if (reporting) return;
    reporting = true;
    progressWrite = (async () => {
      while (nextStage) {
        const current = nextStage;
        nextStage = null;
        await api('/task-progress', { id: event.id, stage: current, project: name }).catch(console.error);
      }
      reporting = false;
    })();
  }
  try {
    if (!name || !state.projects[name]) throw new Error('先发送 /new-project 名称 创建项目，或 /project 名称 切换项目');
    const project = state.projects[name];
    const cwd = await projectPath(root, project.path, isAbsolute(project.path));
    report(event.type === 'plan' ? '正在制定计划' : '正在执行');
    const mode = project.permissionMode === 'auto' ? 'auto' : 'manual';
    const options = {
      cwd,
      abortController: controller,
      env: { ...process.env, WECHAT_BRIDGE_WORKER: '1' },
      ...workerPermissionOptions(mode, approve, requireRemoteApproval),
      settingSources: ['user', 'project', 'local']
    };
    if (event.type === 'plan') {
      options.permissionMode = 'plan';
      delete options.hooks;
      options.canUseTool = async (tool, input) =>
        ['Read', 'Glob', 'Grep', 'LS'].includes(tool)
          ? { behavior: 'allow', updatedInput: input }
          : tool === 'AskUserQuestion' ? approve(tool, input)
            : { behavior: 'deny', message: '制定计划时只允许读取；请先审阅计划。' };
    }
    if (project.sessionId) options.resume = project.sessionId;
    let prompt = event.type === 'plan'
      ? `请只制定可审阅的 Markdown 实施计划，不要修改文件、执行需求或调用 ExitPlanMode；直接在最终回复输出完整计划。需求：\n${event.prompt}` : event.prompt;
    if (event.media) {
      const media = await api(`/media?task=${encodeURIComponent(event.id)}&id=${encodeURIComponent(event.media.id)}`, undefined, 'GET');
      const bytes = Buffer.from(media.data, 'base64');
      if (media.type === 'image') {
        const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png' : 'image/jpeg';
        const promptText = prompt;
        prompt = (async function* () { yield { type: 'user', parent_tool_use_id: null,
          message: { role: 'user', content: [
            { type: 'text', text: promptText },
            { type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } }
          ] } }; })();
      } else {
        const inbox = resolve(dataDir, 'inbox');
        await mkdir(inbox, { recursive: true });
        const safeName = basename(media.name || 'attachment').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100);
        const path = resolve(inbox, `${event.id}-${safeName}`);
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        prompt += `\n\n用户附加文件：${path}。请先读取并结合需求处理。`;
      }
    }
    let lastProgress = 0;
    for await (const message of query({ prompt, options })) {
      const tool = message.type === 'assistant' && message.message?.content?.find((block) => block.type === 'tool_use');
      if (tool && Date.now() - lastProgress > 2000) {
        lastProgress = Date.now();
        report(`${event.type === 'plan' ? '制定计划' : '执行任务'} · ${tool.name}`);
      }
      if (event.type !== 'plan' && mode === 'auto' && message.type === 'system' && message.subtype === 'init' &&
          typeof message.permissionMode === 'string' && message.permissionMode !== 'auto') {
        project.permissionMode = 'manual';
        await saveJson(data, state);
        throw new Error('自动模式在当前 Claude Code/API 配置下不可用，已恢复手动模式；请重新发送任务');
      }
      if (message.session_id && message.session_id !== project.sessionId) {
        project.sessionId = message.session_id;
        await saveJson(data, state);
      }
      if (message.type === 'result') {
        if (message.is_error) throw new Error(message.errors?.join('\n') || 'Claude Code returned an error');
        answer = message.result || message.errors?.join('\n') || (message.is_error ? 'Claude Code returned an error' : 'Completed without text output');
      }
    }
    if (controller.signal.aborted) throw new Error('任务已取消');
    if (event.type === 'plan' && !answer.trim()) throw new Error('Claude Code 未返回计划');
    await progressWrite;
    executionComplete = true;
    if (event.type === 'plan') await api('/plan-ready', { id: event.id, project: name, plan: answer });
    else await api('/task-finish', { id: event.id, status: 'completed', text: `[${name}] ${answer || 'Completed without text output'}` });
  } catch (error) {
    if (state.projects[name]?.permissionMode === 'auto' &&
        /auto mode|classifier|permission mode|not available|unsupported/i.test(error.message)) {
      state.projects[name].permissionMode = 'manual';
      await saveJson(data, state).catch(console.error);
    }
    console.error('Task:', error);
    await progressWrite;
    if (!executionComplete) await api('/task-finish', { id: event.id, status: controller.signal.aborted ? 'cancelled' : 'failed',
      text: `[${name || '未选择'}] ${controller.signal.aborted ? '任务已取消' : `任务失败：${error.message}`}` }).catch(console.error);
  } finally { busy = false; activeRun = null; }
}

async function autoCommand(event) {
  const name = state.active;
  if (!name || !state.projects[name]) {
    await api('/result', { text: '请先选择项目，再设置自动模式。' });
    return;
  }
  const project = state.projects[name];
  if (event.action === 'on' || event.action === 'off') {
    project.permissionMode = event.action === 'on' ? 'auto' : 'manual';
    await saveJson(data, state);
  }
  const enabled = project.permissionMode === 'auto';
  await api('/result', { text: `[${name}] 自动模式${enabled ? '已开启' : '已关闭'}。${enabled ? '无法判断的工具调用仍会请求微信审批；下一条任务生效。' : '需要权限的工具会按手动模式请求审批。'}` });
}

async function projectCommand(event) {
  try {
    if (event.action === 'list') {
      const names = Object.entries(state.projects).map(([name, entry]) =>
        `${name === state.active ? '* ' : '  '}${name}${entry.permissionMode === 'auto' ? ' [自动]' : ''} -> ${entry.path}`);
      await api('/result', { text: `项目根目录：${root}\n${names.join('\n') || '尚无项目'}` });
      await api('/projects', { names: Object.keys(state.projects), active: state.active });
      return;
    }
    if (event.action === 'bulk') {
      const { added, skipped, errors } = await importProjects(root, state.projects, parseProjectList(event.list));
      if (added.length) await saveJson(data, state);
      const lines = [
        `已登记 ${added.length} 个项目${added.length ? `：${added.join('、')}` : ''}`,
        skipped.length ? `已存在 ${skipped.length} 个：${skipped.join('、')}` : '',
        errors.length ? `未登记 ${errors.length} 个：\n${errors.join('\n')}` : '',
        '发送 /projects 查看列表，发送“切换到 项目名”切换。'
      ].filter(Boolean);
      await api('/result', { text: lines.join('\n') });
      return;
    }
    if (event.action === 'select') {
      const requested = event.name.trim();
      const stripQuotes = (value) => value.replace(/^["“「]|["”」]$/g, '').trim();
      const selected = findProject(state.projects, stripQuotes(requested))
        || (requested.endsWith('项目') ? findProject(state.projects, stripQuotes(requested.slice(0, -2))) : null);
      if (!selected) throw new Error('项目不存在，发送 /projects 查看列表');
      await projectPath(root, state.projects[selected].path, isAbsolute(state.projects[selected].path));
      state.active = selected;
    } else if (event.action === 'create') {
      if (!validName(event.name)) throw new Error('项目名只能包含字母、数字、空格、点、下划线和连字符');
      if (findProject(state.projects, event.name)) throw new Error('项目名已存在');
      await createProject(root, event.name);
      state.projects[event.name] = { path: event.name, sessionId: null };
      state.active = event.name;
    } else if (event.action === 'import') {
      if (!validName(event.name)) throw new Error('项目名只能包含字母、数字、空格、点、下划线和连字符');
      if (findProject(state.projects, event.name)) throw new Error('项目名已存在');
      const actual = await projectPath(root, event.path, true);
      state.projects[event.name] = { path: actual, sessionId: null };
      state.active = event.name;
    } else throw new Error('未知项目命令');
    await saveJson(data, state);
    await api('/result', { text: `已选择项目 ${state.active}（${state.projects[state.active].path}）` });
  } catch (error) {
    await api('/result', { text: `项目命令失败：${error.message}` }).catch(console.error);
  }
}

async function fileCommand(event) {
  try {
    const entry = state.projects[state.active];
    if (!entry) throw new Error('请先选择项目');
    const base = await projectPath(root, entry.path, isAbsolute(entry.path));
    const actual = await shareableFile(base, event.path);
    const bytes = await readFile(actual);
    await api('/file-result', { name: basename(actual), data: bytes.toString('base64') });
  } catch (error) { await api('/result', { text: `发送文件失败：${error.message}` }).catch(console.error); }
}

console.log(`Worker ${id.toUpperCase()} ready, project root ${root}`);
while (true) {
  try {
    const { event } = await api(`/next?busy=${busy ? '1' : '0'}`, undefined, 'GET');
    if (!event) continue;
    if (event.type === 'decision') {
      const finish = decisions.get(event.id);
      if (finish) { decisions.delete(event.id); finish(event); }
    } else if (event.type === 'cancel-task') {
      if (activeRun?.id === event.id) activeRun.controller.abort();
    } else if (event.type === 'new') {
      if (state.active && state.projects[state.active]) {
        state.projects[state.active].sessionId = null;
        await saveJson(data, state);
        await api('/result', { text: `项目 ${state.active} 的下一条消息将开启新会话。` });
      }
    } else if (event.type === 'project') {
      await projectCommand(event);
    } else if (event.type === 'file') {
      await fileCommand(event);
    } else if (event.type === 'auto') {
      await autoCommand(event);
    } else if (event.type === 'task' || event.type === 'plan') {
      if (!busy) {
        const selected = event.type === 'task' ? findProject(state.projects, event.prompt) : null;
        if (selected) {
          await projectCommand({ action: 'select', name: selected });
          await api('/task-finish', { id: event.id, status: 'completed', text: '' });
        } else void run(event);
      }
    }
  } catch (error) {
    console.error('Gateway:', error.message);
    await sleep(3000);
  }
}

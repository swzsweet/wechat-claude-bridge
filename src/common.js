import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const code = () => randomBytes(4).toString('hex').toUpperCase();

export async function bridgeToken(dataDir, create = false) {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const path = resolve(dataDir, 'bridge-token.txt');
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(dirname(path), { recursive: true });
    const token = randomBytes(32).toString('hex');
    await writeFile(path, token, { flag: 'wx', mode: 0o600 });
    return token;
  }
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

export function equalSecret(expected, actual) {
  const a = Buffer.from(expected || '');
  const b = Buffer.from(actual || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCommand(text) {
  const value = text.trim();
  const decision = value.match(/^(?:\/)?(批准|拒绝|approve|deny)\s+([A-F0-9]{8})$/i);
  if (decision) return { type: 'decision', allow: /^(批准|approve)$/i.test(decision[1]), id: decision[2].toUpperCase() };
  const answer = value.match(/^(?:\/)?(回答|答|answer)\s+([A-F0-9]{8})\s+(.+)$/i);
  if (answer) return { type: 'answer', id: answer[2].toUpperCase(), answer: answer[3].trim() };
  const route = value.match(/^\/(a|b)(?:\s+([\s\S]+))?$/i);
  if (route) return { type: 'route', worker: route[1].toLowerCase(), prompt: route[2]?.trim() || '' };
  if (value === '/status') return { type: 'status' };
  if (value === '/new') return { type: 'new' };
  if (value === '/projects' || value === '项目列表' || value === '有哪些项目') return { type: 'project', action: 'list' };
  const batch = value.match(/^(?:\/import-projects|登记项目|记住这些项目|这些是项目目录)\s*[:：]?\s*\r?\n([\s\S]+)$/i);
  if (batch) return { type: 'project', action: 'bulk', list: batch[1] };
  if (/^(?:\/import-projects|登记项目|记住这些项目|这些是项目目录)\s*[:：]?$/i.test(value)) return { type: 'project', action: 'await-bulk' };
  const select = value.match(/^\/project\s+(.+)$/i)
    || value.match(/^(?:切换到|切换项目(?:到)?|打开项目|使用项目|项目[：: ])\s*(.+)$/u);
  if (select) return { type: 'project', action: 'select', name: select[1].trim() };
  const create = value.match(/^\/new-project\s+(.+)$/i);
  if (create) return { type: 'project', action: 'create', name: create[1].trim() };
  const add = value.match(/^\/import-project\s+([^\s]+)\s+(.+)$/i);
  if (add) return { type: 'project', action: 'import', name: add[1], path: add[2].trim() };
  return { type: 'prompt', prompt: value };
}

export function describeRequest(tool, input) {
  const detail = JSON.stringify(input, null, 2);
  if (detail.length > 8000) return null;
  return `${tool}\n${detail}`;
}

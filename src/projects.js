import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';

export function validName(name) {
  return /^[\p{L}\p{N}_-](?:[\p{L}\p{N}_ .-]{0,58}[\p{L}\p{N}_-])?$/u.test(name || '');
}

export function findProject(projects, name) {
  const normalized = name.trim().toLocaleLowerCase();
  return Object.keys(projects).find((key) => key.toLocaleLowerCase() === normalized);
}

export function parseProjectList(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 50) throw new Error('一次最多登记 50 个项目');
  return lines.map((line) => {
    const item = line.replace(/^(?:[-*•]\s*|\d+[.)、]\s*)/, '').trim();
    const named = item.match(/^(.+?)\s*(?:=|[|｜：:])\s*(["“「]?(?:[A-Za-z]:[\\/]|\\\\)[\s\S]+)$/u);
    const path = (named ? named[2] : item).replace(/^["“「]|["”」]$/g, '').trim();
    const name = (named ? named[1] : basename(path.replace(/[\\/]+$/, ''))).trim();
    return { name, path };
  });
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel);
}

export async function prepareRoot(path) {
  await mkdir(path, { recursive: true });
  return realpath(path);
}

export async function projectPath(root, location, allowAbsolute = false) {
  if (!location) throw new Error('项目路径不能为空');
  const absolute = isAbsolute(location);
  if (absolute && !allowAbsolute) throw new Error('项目路径必须是根目录内的相对路径');
  const candidate = absolute ? resolve(location) : resolve(root, location);
  if (!absolute && !inside(root, candidate)) throw new Error('项目路径不能超出根目录');
  const actual = await realpath(candidate);
  if (!absolute && !inside(root, actual)) throw new Error('项目路径不能超出根目录');
  if (!(await stat(actual)).isDirectory()) throw new Error('项目必须是已存在的文件夹');
  return actual;
}

export async function importProjects(root, projects, items) {
  const added = [];
  const skipped = [];
  const errors = [];
  for (const { name, path } of items) {
    try {
      if (!validName(name)) throw new Error('项目名无效，请用“名称 = 完整路径”指定简称');
      const actual = await projectPath(root, path, true);
      const existing = findProject(projects, name);
      if (existing) {
        const known = await projectPath(root, projects[existing].path, true);
        if (known !== actual) throw new Error(`名称已用于其他目录：${existing}`);
        skipped.push(name);
        continue;
      }
      projects[name] = { path: actual, sessionId: null };
      added.push(name);
    } catch (error) { errors.push(`${name || path}：${error.message}`); }
  }
  return { added, skipped, errors };
}

export async function createProject(root, name) {
  if (!validName(name)) throw new Error('项目名只能包含字母、数字、空格、下划线、点和连字符');
  const path = resolve(root, name);
  if (!inside(root, path)) throw new Error('项目路径不能超出根目录');
  await mkdir(path, { recursive: false });
  return projectPath(root, name);
}

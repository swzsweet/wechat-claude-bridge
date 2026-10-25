import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, importProjects, parseProjectList, prepareRoot, projectPath } from '../src/projects.js';

test('project registry stays within configured root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wechat-bridge-'));
  try {
    const root = await prepareRoot(join(parent, 'projects'));
    const created = await createProject(root, 'demo');
    assert.equal(await projectPath(root, 'demo'), created);
    await assert.rejects(projectPath(root, '../outside'));
    await assert.rejects(projectPath(root, parent));
    await assert.rejects(createProject(root, '../outside'));
    await mkdir(join(parent, 'outside'));
    await symlink(join(parent, 'outside'), join(root, 'escape'), 'junction');
    await assert.rejects(projectPath(root, 'escape'));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('bulk import remembers external directories and skips the same name and path', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wechat-projects-'));
  try {
    const root = await prepareRoot(join(parent, 'projects'));
    const outside = join(parent, 'outside');
    await mkdir(outside);
    const projects = {};
    const first = await importProjects(root, projects, [{ name: '测试项目', path: outside }]);
    assert.deepEqual(first.added, ['测试项目']);
    assert.equal(projects['测试项目'].path, await projectPath(root, outside, true));
    const again = await importProjects(root, projects, [{ name: '测试项目', path: outside }]);
    assert.deepEqual(again.skipped, ['测试项目']);
    assert.equal(Object.keys(projects).length, 1);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('bulk parser accepts paths, aliases, bullets, and reports invalid lines', () => {
  const items = parseProjectList('网站 = C:\\Work\\client-site\n- 数据分析：D:\\Projects\\analytics\n3. E:\\code\\notes');
  assert.deepEqual(items, [
    { name: '网站', path: 'C:\\Work\\client-site' },
    { name: '数据分析', path: 'D:\\Projects\\analytics' },
    { name: 'notes', path: 'E:\\code\\notes' }
  ]);
  assert.throws(() => parseProjectList(Array(51).fill('C:\\test').join('\n')));
});

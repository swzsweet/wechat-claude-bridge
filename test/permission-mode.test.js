import test from 'node:test';
import assert from 'node:assert/strict';
import { workerPermissionOptions } from '../src/permission-mode.js';

test('manual mode keeps forced WeChat approval and auto mode uses classifier fallback', () => {
  const approve = async () => ({ behavior: 'allow' });
  const requireRemoteApproval = async () => ({});
  const manual = workerPermissionOptions('manual', approve, requireRemoteApproval);
  assert.equal(manual.permissionMode, 'default');
  assert.equal(manual.canUseTool, approve);
  assert.equal(manual.hooks.PreToolUse[0].hooks[0], requireRemoteApproval);

  const auto = workerPermissionOptions('auto', approve, requireRemoteApproval);
  assert.deepEqual(auto, { permissionMode: 'auto', canUseTool: approve });
  assert.equal('allowDangerouslySkipPermissions' in auto, false);
});

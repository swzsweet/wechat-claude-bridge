export function workerPermissionOptions(mode, canUseTool, requireRemoteApproval) {
  if (mode === 'auto') return { permissionMode: 'auto', canUseTool };
  return {
    permissionMode: 'default',
    canUseTool,
    hooks: { PreToolUse: [{
      matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
      hooks: [requireRemoteApproval], timeout: 310
    }] }
  };
}

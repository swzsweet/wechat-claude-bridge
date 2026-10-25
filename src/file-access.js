import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export async function shareableFile(projectDir, requested) {
  if (typeof requested !== 'string' || requested.length > 500) throw new Error('文件路径无效');
  const parts = requested.replace(/\\/g, '/').split('/');
  if (isAbsolute(requested) || /^[A-Za-z]:/.test(requested) ||
      parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') ||
        /^(?:node_modules|data|inbox)$/i.test(part))) throw new Error('只支持项目内的非隐藏文件相对路径');
  if (parts.some((part) => /(?:^|[._-])(?:env|secret|token|password|credential|key)(?:$|[._-])/i.test(part)))
    throw new Error('凭据文件不允许发送');
  if (parts.some((part) => /^(?:id_rsa|id_ed25519|id_ecdsa)$/i.test(part) || /\.(?:pem|p12|pfx|key|kdbx)$/i.test(part)))
    throw new Error('私钥或凭据文件不允许发送');
  const actual = await realpath(resolve(projectDir, ...parts));
  const rel = relative(projectDir, actual);
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))
    throw new Error('文件不在当前项目内');
  const info = await stat(actual);
  if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('只支持 10 MB 以内的普通文件');
  return actual;
}

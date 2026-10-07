import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** 对尚未创建的文件也解析最近现存父目录，阻止链接把状态写入工作区外。 */
export function resolvedPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return resolve(path);
  return join(resolvedPath(parent), relative(parent, path));
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(rel))
  );
}
export function workspaceRoot(path: string): string {
  const root = realpathSync(path);
  if (!statSync(root).isDirectory()) throw new Error('工作区不是目录');
  return root;
}
export function boundedPath(root: string, path: string): string {
  const resolved = resolvedPath(resolve(root, path));
  if (!inside(root, resolved)) throw new Error('拒绝访问工作区之外的路径');
  return resolved;
}

/** 同目录完整写入再原子替换；失败会保留原文件并清理临时文件。 */
export function atomicWrite(root: string, path: string, content: string): void {
  const target = boundedPath(root, path);
  mkdirSync(dirname(target), { recursive: true });
  boundedPath(root, target);
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

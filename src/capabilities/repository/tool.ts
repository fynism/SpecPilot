import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, win32 } from 'node:path';
import { z } from 'zod';
import { boundedPath, inside, workspaceRoot } from '../../integrations/filesystem/paths.js';

export const listInputSchema = z.strictObject({
  path: z.string().min(1).default('.').describe('相对于仓库根目录的目录。'),
  max_depth: z.number().int().min(0).max(10).default(4).describe('向下遍历的最大目录深度。'),
  max_results: z.number().int().min(1).max(500).default(200).describe('最多返回的文件数量。'),
});
export const searchInputSchema = z.strictObject({
  query: z.string().min(1).max(500).describe('要查找的普通文本。'),
  path: z.string().min(1).default('.').describe('相对于仓库根目录的搜索目录。'),
  file_pattern: z.string().min(1).default('*').describe('文件名 glob，例如 *.ts。'),
  max_results: z.number().int().min(1).max(200).default(50),
});
export const readInputSchema = z
  .strictObject({
    path: z.string().min(1).describe('相对于仓库根目录的文件路径。'),
    start_line: z.number().int().min(1).default(1),
    end_line: z.number().int().min(1).nullable().default(null),
    max_chars: z.number().int().min(100).max(100000).default(50000),
  })
  .refine((i) => i.end_line === null || i.end_line >= i.start_line, 'end_line 不能小于 start_line');
const ignored = new Set([
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
]);

/** 严格 UTF-8 流读取并统一换行，管道和大文件不需要一次载入全部内容。 */
async function* lines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let pending = '';
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk as Buffer, { stream: true });
      let index = pending.search(/[\r\n]/);
      while (index >= 0) {
        // CR 在块尾时等待下一块，避免把跨块 CRLF 错算为两行。
        if (pending[index] === '\r' && index === pending.length - 1) break;
        const separatorLength = pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
        yield `${pending.slice(0, index)}\n`;
        pending = pending.slice(index + separatorLength);
        index = pending.search(/[\r\n]/);
      }
    }
    pending += decoder.decode();
    if (pending) yield pending.replace(/\r$/, '\n');
  } finally {
    stream.destroy();
  }
}
function glob(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '*') source += '.*';
    else if (c === '?') source += '.';
    else if (c === '[' && pattern.indexOf(']', i + 1) > i + 1) {
      const end = pattern.indexOf(']', i + 1);
      source += `[${pattern
        .slice(i + 1, end)
        .replace(/^!/, '^')
        .replaceAll('\\', '\\\\')}]`;
      i = end;
    } else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

/** 只读能力统一绑定工作区；绝对路径、穿越和越界链接都不能改变根目录。 */
export class RepositoryReader {
  private readonly root: string;
  constructor(root: string) {
    this.root = workspaceRoot(root);
  }
  private resolve(path: string): string {
    if (isAbsolute(path) || win32.isAbsolute(path)) throw new Error('仓库工具只接受相对路径');
    return boundedPath(this.root, path);
  }
  private async directory(path: string): Promise<string> {
    const resolved = this.resolve(path);
    if (!(await stat(resolved)).isDirectory()) throw new Error('目标不是目录');
    return resolved;
  }
  private async *files(directory: string, depth = 0, maxDepth = Infinity): AsyncGenerator<string> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    for (const e of entries.filter((e) => !e.isDirectory())) {
      const path = join(directory, e.name);
      try {
        const resolved = this.resolve(relative(this.root, path));
        if ((await stat(resolved)).isFile() && inside(this.root, resolved)) yield resolved;
      } catch (error) {
        // 越界链接和消失文件不作为调查候选；根目录的错误由入口明确报告。
        if (!(error instanceof Error)) throw error;
      }
    }
    if (depth < maxDepth)
      for (const e of entries) {
        if (
          e.isDirectory() &&
          !ignored.has(e.name) &&
          !(await lstat(join(directory, e.name))).isSymbolicLink()
        ) {
          yield* this.files(join(directory, e.name), depth + 1, maxDepth);
        }
      }
  }
  async listFiles(input: z.infer<typeof listInputSchema>): Promise<string> {
    const files: string[] = [];
    let truncated = false;
    for await (const file of this.files(await this.directory(input.path), 0, input.max_depth)) {
      if (files.length === input.max_results) {
        truncated = true;
        break;
      }
      files.push(relative(this.root, file).replaceAll('\\', '/'));
    }
    return JSON.stringify({ files, truncated });
  }
  async search(input: z.infer<typeof searchInputSchema>): Promise<string> {
    const matches: { path: string; line: number; text: string }[] = [];
    let truncated = false;
    const pattern = glob(input.file_pattern);
    const query = input.query.toLocaleLowerCase().replaceAll('ß', 'ss');
    for await (const file of this.files(await this.directory(input.path))) {
      if (!pattern.test(file.split(/[\\/]/).at(-1) ?? '') || (await stat(file)).size > 1000000)
        continue;
      try {
        let line = 0;
        for await (const content of lines(file)) {
          line++;
          if (!content.toLocaleLowerCase().replaceAll('ß', 'ss').includes(query)) continue;
          if (matches.length === input.max_results) {
            truncated = true;
            break;
          }
          matches.push({
            path: relative(this.root, file).replaceAll('\\', '/'),
            line,
            text: content.replace(/[\r\n]+$/, '').slice(0, 500),
          });
        }
      } catch (error) {
        if (!(error instanceof Error && (error instanceof TypeError || 'code' in error)))
          throw error;
        // 保留原行为：搜索跳过二进制或不可读文件；直接读取会明确返回失败。
      }
      if (truncated) break;
    }
    return JSON.stringify({ matches, truncated });
  }
  async readFile(input: z.infer<typeof readInputSchema>): Promise<string> {
    const file = this.resolve(input.path);
    if (!(await stat(file)).isFile()) throw new Error('目标不是可读取文件');
    const parts: string[] = [];
    let count = 0;
    let last = input.start_line - 1;
    let truncated = false;
    let line = 0;
    for await (const content of lines(file)) {
      line++;
      if (line < input.start_line) continue;
      if (input.end_line !== null && line > input.end_line) break;
      const chars = Array.from(content);
      const remaining = input.max_chars - count;
      parts.push(chars.slice(0, remaining).join(''));
      last = line;
      if (chars.length > remaining) {
        truncated = true;
        break;
      }
      count += chars.length;
    }
    return JSON.stringify({
      path: relative(this.root, file).replaceAll('\\', '/'),
      start_line: input.start_line,
      end_line: last,
      content: parts.join(''),
      truncated,
    });
  }
}

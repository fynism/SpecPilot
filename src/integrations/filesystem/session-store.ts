import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  type SessionRecord,
  sessionIdSchema,
  sessionSchema,
} from '../../runtime/session/models.js';
import {
  SessionNotFoundError,
  SessionStorageError,
  type SessionStore,
} from '../../runtime/session/store.js';
import { atomicWrite, boundedPath, workspaceRoot } from './paths.js';

const indexSchema = z
  .strictObject({
    schema_version: z.literal(1).default(1),
    active_session_id: sessionIdSchema.nullable().default(null),
    session_ids: z.array(sessionIdSchema).default([]),
  })
  .refine(
    (index) =>
      new Set(index.session_ids).size === index.session_ids.length &&
      (index.active_session_id === null || index.session_ids.includes(index.active_session_id)),
    'Session 索引不一致',
  );
type SessionIndex = z.infer<typeof indexSchema>;

/** 原子 JSON 持久化，保持 Python 的工作区目录和索引格式。 */
export class LocalSessionStore implements SessionStore {
  private readonly root: string;
  constructor(workspace: string) {
    this.root = workspaceRoot(workspace);
    boundedPath(this.root, '.specpilot/sessions');
  }
  private path(id: string): string {
    if (!sessionIdSchema.safeParse(id).success)
      throw new SessionNotFoundError('Session ID 格式无效');
    return boundedPath(this.root, `.specpilot/sessions/${id}/session.json`);
  }
  private indexPath(): string {
    return boundedPath(this.root, '.specpilot/sessions/index.json');
  }
  private index(): SessionIndex {
    const path = this.indexPath();
    if (!existsSync(path)) return indexSchema.parse({});
    try {
      return indexSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      throw new SessionStorageError('Session 索引损坏或版本不兼容', { cause: error });
    }
  }
  private writeIndex(index: SessionIndex): void {
    atomicWrite(
      this.root,
      this.indexPath(),
      `${JSON.stringify(indexSchema.parse(index), null, 2)}\n`,
    );
  }
  save(input: SessionRecord): void {
    const session = sessionSchema.safeParse(input);
    if (!session.success)
      throw new SessionStorageError('拒绝保存不一致的 Session 快照', { cause: session.error });
    const index = this.index();
    try {
      atomicWrite(
        this.root,
        this.path(session.data.session_id),
        this.backupLegacy(session.data.session_id, session.data),
      );
      if (!index.session_ids.includes(session.data.session_id)) {
        index.session_ids.push(session.data.session_id);
        this.writeIndex(index);
      }
    } catch (error) {
      throw new SessionStorageError('无法安全写入 Session 文件', { cause: error });
    }
  }
  private backupLegacy(id: string, session: SessionRecord): string {
    const path = this.path(id);
    if (existsSync(path)) {
      const original = readFileSync(path, 'utf8');
      const version: unknown = JSON.parse(original).schema_version;
      // 升级前保留旧格式原始字节；不覆盖已有备份，也不从未校验字段构造路径。
      if (version === 1 || version === 2 || version === 3) {
        const backup = `${path}.v${version}.bak`;
        if (!existsSync(backup)) atomicWrite(this.root, backup, original);
      }
    }
    return `${JSON.stringify(session, null, 2)}\n`;
  }
  load(id: string): SessionRecord {
    const path = this.path(id);
    if (!existsSync(path)) throw new SessionNotFoundError(`Session 不存在：${id}`);
    try {
      return sessionSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      throw new SessionStorageError(`Session 数据损坏或不兼容：${id}`, { cause: error });
    }
  }
  listSessions(): SessionRecord[] {
    return this.index()
      .session_ids.map((id) => this.load(id))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }
  activeSessionId(): string | null {
    return this.index().active_session_id;
  }
  setActive(id: string): void {
    this.load(id);
    const index = this.index();
    if (!index.session_ids.includes(id))
      throw new SessionNotFoundError('Session 不在当前工作区索引中');
    this.writeIndex({ ...index, active_session_id: id });
  }
}

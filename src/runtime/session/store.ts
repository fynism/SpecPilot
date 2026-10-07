import type { SessionRecord } from './models.js';

export class SessionStorageError extends Error {}
export class SessionNotFoundError extends Error {}
export interface SessionStore {
  save(session: SessionRecord): void;
  load(id: string): SessionRecord;
  listSessions(): SessionRecord[];
  activeSessionId(): string | null;
  setActive(id: string): void;
}

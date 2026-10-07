import { type Clock, newId, type Specification, utcNow } from '../../capabilities/spec/models.js';
import { SpecToolService } from '../../capabilities/spec/operations.js';
import { InMemorySpecStore } from '../../capabilities/spec/store.js';
import type { Message } from '../model.js';
import { createSessionRecord, type SessionRecord } from './models.js';
import type { SessionStore } from './store.js';

/** 在完整 Agent 轮次之间管理隔离与恢复，不重放可能已产生副作用的调用。 */
export class SessionManager {
  private record?: SessionRecord;
  private specStore?: InMemorySpecStore;
  constructor(
    private readonly store: SessionStore,
    private readonly clock: Clock = utcNow,
    private readonly idFactory: () => string = () => newId('SS'),
  ) {}
  private require(): { record: SessionRecord; specStore: InMemorySpecStore } {
    if (!this.record || !this.specStore) throw new Error('SessionManager 尚未启动');
    return { record: this.record, specStore: this.specStore };
  }
  get current(): SessionRecord {
    const { record, specStore } = this.require();
    return structuredClone({ ...record, spec_versions: specStore.history(record.spec_id) });
  }
  get messages(): Message[] {
    return this.require().record.messages;
  }
  get specTools(): SpecToolService {
    const { record, specStore } = this.require();
    return new SpecToolService(specStore, record.spec_id, this.clock);
  }
  currentSpec(): Specification {
    return this.specTools.currentSpec();
  }
  private activate(session: SessionRecord): void {
    this.record = structuredClone(session);
    this.specStore = InMemorySpecStore.fromHistory(session.spec_versions, this.clock);
  }
  private persist(record: SessionRecord): void {
    const snapshot = { ...record, spec_versions: this.require().specStore.history(record.spec_id) };
    this.store.save(snapshot);
    this.record = snapshot;
  }
  private recover(session: SessionRecord): SessionRecord {
    if (session.status !== 'running') return session;
    const interrupted = { ...session, status: 'interrupted' as const, updated_at: this.clock() };
    this.store.save(interrupted);
    return interrupted;
  }
  start(): SessionRecord {
    const active = this.store.activeSessionId();
    if (active === null) return this.create();
    this.activate(this.recover(this.store.load(active)));
    return this.current;
  }
  create(title = '新对话'): SessionRecord {
    if (this.record?.status === 'running') throw new Error('Agent 运行中不能创建 Session');
    const session = createSessionRecord(title, this.clock(), this.idFactory());
    this.store.save(session);
    this.store.setActive(session.session_id);
    this.activate(session);
    return this.current;
  }
  switch(id: string): SessionRecord {
    if (this.require().record.status === 'running') throw new Error('Agent 运行中不能切换 Session');
    const session = this.recover(this.store.load(id));
    this.store.setActive(id);
    this.activate(session);
    return this.current;
  }
  rename(title: string): SessionRecord {
    if (this.require().record.status === 'running')
      throw new Error('Agent 运行中不能重命名 Session');
    this.persist({ ...this.current, title: title.trim(), updated_at: this.clock() });
    return this.current;
  }
  listSessions(): SessionRecord[] {
    return this.store.listSessions();
  }
  beginTurn(request: string): void {
    const session = this.current;
    if (!request.trim()) throw new Error('用户请求不能为空');
    if (!['waiting_for_user', 'interrupted'].includes(session.status))
      throw new Error('当前状态不能开始新轮次');
    // 先保存稳定运行起点；失败不能把未配对 tool_use 写为恢复点。
    this.persist({
      ...session,
      status: 'running',
      active_request: request,
      messages: [...session.messages, { role: 'user', content: request }],
      updated_at: this.clock(),
    });
  }
  completeTurn(): void {
    if (this.require().record.status !== 'running') throw new Error('当前没有运行中的轮次');
    this.persist({
      ...this.current,
      status: 'waiting_for_user',
      active_request: null,
      updated_at: this.clock(),
    });
  }
  interruptTurn(): void {
    const { record } = this.require();
    if (record.status !== 'running') return;
    // 从磁盘恢复 beginTurn 的稳定快照，丢弃未提交 Spec 与不完整工具协议。
    const stable = this.store.load(record.session_id);
    const interrupted = { ...stable, status: 'interrupted' as const, updated_at: this.clock() };
    this.store.save(interrupted);
    this.activate(interrupted);
  }
}

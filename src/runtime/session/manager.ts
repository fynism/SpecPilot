import { ClarificationPlanService } from '../../capabilities/clarification/plan.js';
import { isClarificationStopRequest } from '../../capabilities/clarification/policy.js';
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
    return new SpecToolService(specStore, record.spec_id, this.clock, () =>
      this.clarification.validationIssues(),
    );
  }
  get clarification(): ClarificationPlanService {
    return this.clarificationService();
  }
  clarificationService(published?: () => void): ClarificationPlanService {
    return new ClarificationPlanService(
      this.require().record.session_id,
      () => this.require().record.clarification_plan,
      (plan) => {
        const record = { ...this.current, clarification_plan: plan, updated_at: this.clock() };
        if (record.status === 'running') {
          // Loop 持有 messages 引用；仅更新规划字段，不能替换运行中的消息容器。
          this.require().record.clarification_plan = plan;
          this.require().record.updated_at = record.updated_at;
        } else this.persist(record);
      },
      () => this.currentSpec(),
      published,
    );
  }
  editClarification(input: Parameters<ClarificationPlanService['edit']>[0]): void {
    if (this.current.status === 'running') throw new Error('Agent 运行中不能编辑答案');
    this.clarification.edit(input);
  }
  deferClarification(id: string, deferred: boolean): void {
    if (this.current.status === 'running') throw new Error('Agent 运行中不能暂缓问题');
    this.clarification.defer(id, deferred);
  }
  submitClarification(id: string, note = ''): string | null {
    if (this.current.status === 'running') throw new Error('Agent 运行中不能重复提交');
    return this.clarification.submit(id, note);
  }
  setClarificationNote(note: string): void {
    if (this.current.status === 'running') throw new Error('Agent 运行中不能编辑补充说明');
    this.clarification.setNote(note);
  }
  retryClarification(): string {
    if (this.current.status === 'running') throw new Error('Agent 运行中不能重试');
    return this.clarification.retry();
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
    for (const submission of interrupted.clarification_plan.submissions)
      if (submission.status === 'pending') submission.status = 'retry';
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
    const specStore = this.require().specStore;
    try {
      // 已提交答案的证据由宿主创建，模型只能引用；草稿不进入 Spec。
      const spec = this.currentSpec();
      const answers = isClarificationStopRequest(request)
        ? []
        : session.clarification_plan.answers.filter(
            (a) =>
              a.submission_id && !spec.evidence.some((e) => e.locator === `clarification:${a.id}`),
          );
      const pendingSubmission = session.clarification_plan.submissions.some(
        (s) => s.status === 'pending',
      );
      const notes = isClarificationStopRequest(request)
        ? []
        : session.clarification_plan.submissions.filter(
            (s) =>
              s.note.trim() &&
              !spec.evidence.some((e) => e.locator === `clarification-note:${s.id}`),
          );
      if (
        !isClarificationStopRequest(request) &&
        (answers.length || pendingSubmission) &&
        ['ready_for_approval', 'approved'].includes(spec.status)
      ) {
        this.specTools.applySpecPatch({
          expected_version: spec.version,
          change_reason: '用户提交新的澄清信息，撤回旧的准备状态',
          operations: [{ op: 'set_spec_metadata', title: null, status: 'revised' }],
        });
      }
      if (answers.length || notes.length) {
        let next = Math.max(0, ...spec.evidence.map((e) => Number(e.id.slice(2))));
        const records = [
          ...answers.map((a) => ({
            summary: `用户选项：${a.answer.selected_option_id ?? '未选择'}\n用户补充：${a.answer.free_text ?? '无'}`,
            locator: `clarification:${a.id}`,
          })),
          ...notes.map((s) => ({ summary: s.note, locator: `clarification-note:${s.id}` })),
        ];
        for (let offset = 0; offset < records.length; offset += 20) {
          const current = this.currentSpec();
          this.specTools.applySpecPatch(
            {
              expected_version: current.version,
              change_reason: '保存真实澄清提交证据',
              operations: records.slice(offset, offset + 20).map((a) => ({
                op: 'record_evidence' as const,
                id: `E-${String(++next).padStart(3, '0')}`,
                kind: 'clarification' as const,
                summary: a.summary,
                locator: a.locator,
              })),
            },
            true,
          );
        }
      }
      // 先保存稳定运行起点；失败不能把未配对 tool_use 写为恢复点。
      this.persist({
        ...this.current,
        status: 'running',
        active_request: request,
        messages: [...session.messages, { role: 'user', content: request }],
        updated_at: this.clock(),
      });
    } catch (error) {
      // 保持已装配服务的 Store 身份，撤回未保存的宿主证据与状态变更。
      specStore.restoreHistory(session.spec_versions);
      throw error;
    }
  }

  completeTurn(): void {
    if (this.require().record.status !== 'running') throw new Error('当前没有运行中的轮次');
    this.clarification.markRetry();
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
    this.clarification.markRetry();
    this.persist(this.current);
  }
}

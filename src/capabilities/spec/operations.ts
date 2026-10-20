import { z } from 'zod';
import {
  boundarySchema,
  type Clock,
  createSpecification,
  decisionSchema,
  evidenceSchema,
  goalSchema,
  requirementSchema,
  type Specification,
  specEntities,
  specificationSchema,
  utcNow,
} from './models.js';
import { InMemorySpecStore } from './store.js';
import { type ValidationIssue, validateSpecification } from './validation.js';

const operationsSchema = z.discriminatedUnion('op', [
  goalSchema.omit({ lifecycle: true }).extend({ op: z.literal('put_goal') }),
  boundarySchema.omit({ lifecycle: true }).extend({ op: z.literal('put_boundary') }),
  requirementSchema.omit({ lifecycle: true }).extend({ op: z.literal('put_requirement') }),
  decisionSchema
    .omit({ lifecycle: true, decided_at: true })
    .extend({ op: z.literal('record_decision'), evidence_ids: z.array(z.string()).min(1) }),
  evidenceSchema.omit({ captured_at: true }).extend({ op: z.literal('record_evidence') }),
  z.strictObject({ op: z.literal('retire_item'), id: z.string().regex(/^(G|S|R|D)-[0-9]{3}$/) }),
  z.strictObject({
    op: z.literal('set_spec_metadata'),
    title: z.string().trim().min(1).max(200).nullable().default(null),
    status: z.enum(['draft', 'clarifying', 'revised']).nullable().default(null),
  }),
]);
export const patchSchema = z.strictObject({
  expected_version: z.number().int().min(1).describe('调用方读取到的当前 Spec 版本。'),
  change_reason: z.string().trim().min(1).max(1000).describe('本次修改的原因。'),
  operations: z.array(operationsSchema).min(1).max(20),
});
export type SpecPatch = z.infer<typeof patchSchema>;

/** 固定领域错误可返回模型；外部异常仍由 Executor 脱敏。 */
export class SpecMutationError extends Error {
  constructor(
    readonly code: 'version_conflict' | 'immutable_evidence',
    message: string,
  ) {
    super(message);
  }
}
/** 原子更新精简 Spec，保留来源与版本；就绪状态只能由宿主计算。 */
export class SpecToolService {
  constructor(
    readonly store: InMemorySpecStore,
    readonly specId: string,
    private readonly clock: Clock = utcNow,
    private readonly additionalIssues: () => ValidationIssue[] = () => [],
  ) {}
  static create(title = '当前需求', clock: Clock = utcNow): SpecToolService {
    const store = new InMemorySpecStore(clock);
    const spec = store.create(createSpecification(title, clock()));
    return new SpecToolService(store, spec.spec_id, clock);
  }
  currentSpec(): Specification {
    return this.store.get(this.specId);
  }
  getSpec(): string {
    return JSON.stringify(this.currentSpec());
  }
  validation() {
    const result = validateSpecification(this.currentSpec());
    result.issues.push(...this.additionalIssues());
    result.ready_for_approval = !result.issues.some((i) => i.severity === 'error');
    return result;
  }
  validateSpec(): string {
    return JSON.stringify(this.validation());
  }

  /** 仅供宿主在多轮发布成功后调用，与整轮快照一起提交；不授予批准权限。 */
  finishClarificationRound(hasQuestions: boolean): void {
    const current = this.currentSpec();
    const status =
      !hasQuestions && this.validation().ready_for_approval ? 'ready_for_approval' : 'clarifying';
    if (current.status === status) return;
    this.store.save(
      {
        ...current,
        status,
        change_reason:
          status === 'ready_for_approval' ? '宿主检查通过，交由用户复核' : '仍需澄清或补全验收',
      },
      current.version,
    );
  }
  applySpecPatch(input: SpecPatch, hostEvidence = false): string {
    const patch = patchSchema.parse(input);
    const working = this.currentSpec();
    if (working.version !== patch.expected_version)
      throw new SpecMutationError('version_conflict', 'Spec 版本冲突，请重新 get_spec');
    working.change_reason = patch.change_reason;
    // 新事实使旧的准备状态失效；模型不能在同一个 Patch 中恢复或批准。
    if (['ready_for_approval', 'approved'].includes(working.status)) working.status = 'revised';
    for (const operation of patch.operations) {
      if (operation.op === 'set_spec_metadata') {
        if (operation.title !== null) working.title = operation.title;
        if (operation.status !== null) working.status = operation.status;
      } else if (operation.op === 'retire_item') {
        const item = specEntities(working).find((e) => e.id === operation.id);
        if (!item) throw new Error(`要停用的 Spec 实体不存在：${operation.id}`);
        item.lifecycle = 'retired';
      } else if (operation.op === 'put_goal') {
        const { op: _op, ...data } = operation;
        working.goal = { ...data, lifecycle: 'active' };
      } else {
        const { op, ...data } = operation;
        if (op === 'record_evidence') {
          if (
            !hostEvidence &&
            (operation.locator.startsWith('clarification:ANSWER-') ||
              operation.locator.startsWith('clarification-note:'))
          )
            throw new SpecMutationError(
              'immutable_evidence',
              '宿主澄清证据只能由真实提交创建，请引用已有 Evidence ID',
            );
          const existing = working.evidence.find((e) => e.id === data.id);
          if (existing) {
            if (
              existing.summary !== operation.summary ||
              existing.kind !== operation.kind ||
              existing.locator !== operation.locator
            )
              throw new SpecMutationError(
                'immutable_evidence',
                'Evidence 不可改写，请引用已有 Evidence ID',
              );
            continue;
          }
        }
        const mapping = {
          put_boundary: 'boundaries',
          put_requirement: 'requirements',
          record_decision: 'decisions',
          record_evidence: 'evidence',
        } as const;
        const item = {
          ...data,
          ...(op === 'record_evidence' ? { captured_at: this.clock() } : { lifecycle: 'active' }),
          ...(op === 'record_decision' ? { decided_at: this.clock() } : {}),
        };
        // 同批可以先写结论再写来源，整批通过 Schema 后才提交。
        const items: { id: string }[] = working[mapping[op]];
        const index = items.findIndex((e) => e.id === item.id);
        if (index < 0) items.push(item);
        else items[index] = item;
      }
    }
    return JSON.stringify(
      this.store.save(specificationSchema.parse(working), patch.expected_version),
    );
  }
}

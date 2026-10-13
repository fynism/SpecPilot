import { z } from 'zod';
import {
  assumptionSchema,
  type Clock,
  createSpecification,
  criterionSchema,
  decisionSchema,
  entityFields,
  evidenceSchema,
  goalSchema,
  questionSchema,
  requirementSchema,
  type Specification,
  scopeSchema,
  specificationSchema,
  utcNow,
} from './models.js';
import { InMemorySpecStore } from './store.js';
import { type ValidationIssue, validateSpecification } from './validation.js';

const operationsSchema = z.discriminatedUnion('op', [
  goalSchema.omit({ lifecycle: true }).extend({ op: z.literal('put_goal') }),
  scopeSchema.omit({ lifecycle: true }).extend({ op: z.literal('put_scope_item') }),
  requirementSchema.omit({ lifecycle: true }).extend({ op: z.literal('put_requirement') }),
  decisionSchema
    .omit({ lifecycle: true, decided_at: true })
    .extend({ op: z.literal('record_decision'), evidence_ids: z.array(z.string()).min(1) }),
  assumptionSchema.omit({ lifecycle: true }).extend({ op: z.literal('put_assumption') }),
  // 操作输入保留局部约束，跨实体引用在整批提交时校验。
  z
    .strictObject({ ...questionSchema.shape, op: z.literal('put_open_question') })
    .omit({ lifecycle: true }),
  z
    .strictObject({ ...criterionSchema.shape, op: z.literal('put_acceptance_criterion') })
    .omit({ lifecycle: true }),
  evidenceSchema.omit({ captured_at: true }).extend({ op: z.literal('record_evidence') }),
  z.strictObject({
    op: z.literal('retire_item'),
    id: z.string().regex(/^(G|S|R|D|A|OQ|AC)-[0-9]{3}$/),
  }),
  z.strictObject({
    op: z.literal('set_spec_metadata'),
    title: z.string().min(1).max(200).nullable().default(null),
    status: z
      .enum(['draft', 'clarifying', 'ready_for_approval', 'revised'])
      .nullable()
      .default(null),
  }),
]);
export const patchSchema = z.strictObject({
  expected_version: z.number().int().min(1).describe('调用方读取到的当前 Spec 版本。'),
  change_reason: z.string().min(1).max(1000).describe('本次修改的原因。'),
  operations: z.array(operationsSchema).min(1).max(20),
});
export type SpecPatch = z.infer<typeof patchSchema>;

/** 固定领域错误可返回模型；外部异常仍由 Executor 脱敏。 */
export class SpecMutationError extends Error {
  constructor(
    readonly code: 'version_conflict' | 'immutable_evidence' | 'clarification_pending',
    message: string,
  ) {
    super(message);
  }
}

/** Spec 修改入口；整批操作完成后校验并一次追加版本。 */
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
  validateSpec(): string {
    const result = validateSpecification(this.currentSpec());
    result.issues.push(...this.additionalIssues());
    result.ready_for_approval = !result.issues.some((i) => i.severity === 'error');
    return JSON.stringify(result);
  }

  applySpecPatch(input: SpecPatch): string {
    const patch = patchSchema.parse(input);
    const working = this.currentSpec();
    if (working.version !== patch.expected_version)
      throw new SpecMutationError('version_conflict', 'Spec 版本冲突，请重新 get_spec');
    working.change_reason = patch.change_reason;
    for (const operation of patch.operations) {
      if (operation.op === 'set_spec_metadata') {
        if (operation.title !== null) working.title = operation.title;
        if (operation.status !== null) working.status = operation.status;
      } else if (operation.op === 'retire_item') {
        const item = entityFields
          .flatMap((field) => working[field])
          .find((e) => e.id === operation.id);
        if (!item) throw new Error(`要停用的 Spec 实体不存在：${operation.id}`);
        item.lifecycle = 'retired';
      } else {
        const { op, ...data } = operation;
        if (op === 'record_evidence') {
          const existing = working.evidence.find((e) => e.id === data.id);
          if (
            existing &&
            (existing.summary !== operation.summary ||
              existing.kind !== operation.kind ||
              existing.locator !== operation.locator)
          )
            throw new SpecMutationError(
              'immutable_evidence',
              'Evidence 不可改写；真实澄清提交已有宿主证据，请按 locator 引用现有 Evidence ID',
            );
        }
        const mapping = {
          put_goal: 'goals',
          put_scope_item: 'scope',
          put_requirement: 'requirements',
          record_decision: 'decisions',
          put_assumption: 'assumptions',
          put_open_question: 'open_questions',
          put_acceptance_criterion: 'acceptance_criteria',
          record_evidence: 'evidence',
        } as const;
        const field = mapping[op];
        const item = {
          ...data,
          ...(op === 'record_evidence' ? { captured_at: this.clock() } : { lifecycle: 'active' }),
          ...(op === 'record_decision' ? { decided_at: this.clock() } : {}),
        };
        // 暂存 JSON 形状允许同批前向引用，最终统一 Zod 校验后才提交到 Store。
        const items: { id: string }[] = working[field];
        const index = items.findIndex((e) => e.id === item.id);
        if (index < 0) items.push(item);
        else items[index] = item;
      }
    }
    const candidate = specificationSchema.parse(working);
    if (
      candidate.status === 'ready_for_approval' &&
      this.additionalIssues().some((i) => i.severity === 'error')
    )
      throw new SpecMutationError(
        'clarification_pending',
        '存在未完成的澄清事项，不能进入待批准状态；请先只提交事实，随后发布问题状态',
      );
    return JSON.stringify(this.store.save(candidate, patch.expected_version));
  }
}

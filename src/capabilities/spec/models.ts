import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const timestamp = z.iso.datetime({ offset: true });
const text = z.string().min(1).max(2000);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[0-9]{3}$`));
const entity = {
  statement: text,
  evidence_ids: z.array(z.string()).default([]),
  lifecycle: z.enum(['active', 'retired']).default('active'),
};
export const goalSchema = z.strictObject({ ...entity, id: id('G') });
export const scopeSchema = z.strictObject({
  ...entity,
  id: id('S'),
  disposition: z.enum(['in_scope', 'out_of_scope']),
});
export const requirementSchema = z.strictObject({
  ...entity,
  id: id('R'),
  acceptance_criterion_ids: z.array(z.string()).default([]),
});
export const decisionSchema = z.strictObject({
  ...entity,
  id: id('D'),
  rationale: text,
  made_by: z.enum(['user', 'project']),
  decided_at: timestamp,
  supersedes_id: id('D').nullable().default(null),
});
export const assumptionSchema = z.strictObject({
  ...entity,
  id: id('A'),
  confidence: z.number().min(0).max(1),
  impact: z.string().min(1).max(1000),
  invalidation_condition: z.string().min(1).max(1000),
});
export const questionSchema = z
  .strictObject({
    ...entity,
    id: id('OQ'),
    blocking: z.boolean(),
    status: z.enum(['open', 'resolved']).default('open'),
    resolution_decision_id: id('D').nullable().default(null),
  })
  .refine(
    (q) => (q.status === 'resolved') === (q.resolution_decision_id !== null),
    '已解决问题必须引用 Decision，未解决问题不能提前引用',
  );
export const criterionSchema = z
  .strictObject({
    ...entity,
    id: id('AC'),
    requirement_ids: z.array(z.string()).min(1),
    given: z.string().min(1).max(1000).nullable().default(null),
    when: z.string().min(1).max(1000).nullable().default(null),
    // biome-ignore lint/suspicious/noThenProperty: BDD 持久化字段必须兼容原契约，此值不是函数。
    then: z.string().min(1).max(1000).nullable().default(null),
  })
  .refine(
    (ac) =>
      [ac.given, ac.when, ac.then].every((p) => p === null) ||
      [ac.given, ac.when, ac.then].every((p) => p !== null),
    'BDD 场景必须同时提供 given、when 和 then',
  );
export const evidenceSchema = z.strictObject({
  id: id('E'),
  kind: z.enum(['user_statement', 'clarification', 'repository', 'tool_result', 'test']),
  summary: text,
  locator: text,
  captured_at: timestamp,
});
export const entityFields = [
  'goals',
  'scope',
  'requirements',
  'decisions',
  'assumptions',
  'open_questions',
  'acceptance_criteria',
] as const;
export const specificationSchema = z
  .strictObject({
    schema_version: z.literal(1).default(1),
    spec_id: z.string().regex(/^SP-[0-9a-f]{12}$/),
    version: z.number().int().min(1).default(1),
    status: z
      .enum(['draft', 'clarifying', 'ready_for_approval', 'approved', 'revised'])
      .default('draft'),
    title: z.string().min(1).max(200),
    created_at: timestamp,
    updated_at: timestamp,
    change_reason: z.string().min(1).max(1000).default('创建初始 Spec'),
    goals: z.array(goalSchema).default([]),
    scope: z.array(scopeSchema).default([]),
    requirements: z.array(requirementSchema).default([]),
    decisions: z.array(decisionSchema).default([]),
    assumptions: z.array(assumptionSchema).default([]),
    open_questions: z.array(questionSchema).default([]),
    acceptance_criteria: z.array(criterionSchema).default([]),
    evidence: z.array(evidenceSchema).default([]),
  })
  .superRefine((spec, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const entities = entityFields.flatMap((field) => spec[field]);
    const all = [...entities, ...spec.evidence];
    if (new Set(all.map((item) => item.id)).size !== all.length)
      fail('同一个 Spec 中的实体 ID 必须唯一');
    const evidence = new Map(spec.evidence.map((e) => [e.id, e]));
    for (const e of entities)
      if (e.evidence_ids.some((ref) => !evidence.has(ref)))
        fail(`实体 ${e.id} 引用了不存在的 Evidence`);
    const refs = (ids: string[], items: { id: string }[]) =>
      ids.some((ref) => !items.some((item) => item.id === ref));
    for (const r of spec.requirements)
      if (refs(r.acceptance_criterion_ids, spec.acceptance_criteria))
        fail(`需求 ${r.id} 引用了不存在的 AcceptanceCriterion`);
    for (const ac of spec.acceptance_criteria)
      if (refs(ac.requirement_ids, spec.requirements))
        fail(`验收条件 ${ac.id} 引用了不存在的 Requirement`);
    for (const q of spec.open_questions)
      if (q.resolution_decision_id && refs([q.resolution_decision_id], spec.decisions))
        fail(`问题 ${q.id} 引用了不存在的 Decision`);
    for (const d of spec.decisions) {
      if (d.supersedes_id && refs([d.supersedes_id], spec.decisions))
        fail(`决策 ${d.id} 引用了不存在的旧 Decision`);
      // 决策者是信任边界，仓库证据不能伪造用户已经确认。
      const kinds = d.evidence_ids.map((ref) => evidence.get(ref)?.kind);
      if (
        d.made_by === 'user' &&
        !kinds.some((kind) => kind === 'user_statement' || kind === 'clarification')
      )
        fail(`用户决策 ${d.id} 必须引用用户陈述或澄清回答`);
      if (d.made_by === 'project' && !kinds.includes('repository'))
        fail(`项目决策 ${d.id} 必须引用仓库证据`);
    }
  });
export type Specification = z.infer<typeof specificationSchema>;
export type Clock = () => string;
export const utcNow: Clock = () => new Date().toISOString();
export const newId = (prefix: string): string =>
  `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;

/** 创建独立空白 Spec，保持 Python 持久化 ID 和时间契约。 */
export function createSpecification(title: string, now = utcNow()): Specification {
  return specificationSchema.parse({
    spec_id: newId('SP'),
    title,
    created_at: now,
    updated_at: now,
  });
}

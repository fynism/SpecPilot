import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const timestamp = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(2000);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[0-9]{3}$`));
const entity = {
  statement: text,
  evidence_ids: z.array(z.string()).default([]),
  lifecycle: z.enum(['active', 'retired']).default('active'),
};
export const goalSchema = z.strictObject({ ...entity, id: z.literal('G-001') });
export const boundarySchema = z.strictObject({
  ...entity,
  id: id('S'),
  disposition: z.enum(['in_scope', 'out_of_scope', 'constraint']),
});
export const requirementSchema = z.strictObject({
  ...entity,
  id: id('R'),
  acceptance_examples: z
    .array(text)
    .default([])
    .describe('直接归属于本需求的可验证示例；未知内容留空。'),
});
export const decisionSchema = z.strictObject({
  ...entity,
  id: id('D'),
  rationale: text,
  made_by: z.literal('user').default('user'),
  decided_at: timestamp,
  supersedes_id: id('D').nullable().default(null),
});
export const evidenceSchema = z.strictObject({
  id: id('E'),
  kind: z.enum(['user_statement', 'clarification', 'repository', 'tool_result', 'test']),
  summary: text,
  locator: text,
  captured_at: timestamp,
});
const specificationFields = {
  schema_version: z.literal(2),
  spec_id: z.string().regex(/^SP-[0-9a-f]{12}$/),
  version: z.number().int().min(1).default(1),
  status: z
    .enum(['draft', 'clarifying', 'ready_for_approval', 'approved', 'revised'])
    .default('draft'),
  title: z.string().trim().min(1).max(200),
  created_at: timestamp,
  updated_at: timestamp,
  change_reason: z.string().trim().min(1).max(1000).default('创建初始 Spec'),
  goal: goalSchema.nullable().default(null),
  boundaries: z.array(boundarySchema).default([]),
  requirements: z.array(requirementSchema).default([]),
  decisions: z.array(decisionSchema).default([]),
  evidence: z.array(evidenceSchema).default([]),
};
type SpecEntities = z.output<
  typeof goalSchema | typeof boundarySchema | typeof requirementSchema | typeof decisionSchema
>;
/** 统一枚举可关联结论，避免澄清与终端各自维护实体类型清单。 */
export function specEntities(spec: {
  goal: z.output<typeof goalSchema> | null;
  boundaries: z.output<typeof boundarySchema>[];
  requirements: z.output<typeof requirementSchema>[];
  decisions: z.output<typeof decisionSchema>[];
}): SpecEntities[] {
  return [
    ...(spec.goal ? [spec.goal] : []),
    ...spec.boundaries,
    ...spec.requirements,
    ...spec.decisions,
  ];
}
export const specificationSchema = z.strictObject(specificationFields).superRefine((spec, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const entities = specEntities(spec);
  const all = [...entities, ...spec.evidence];
  if (new Set(all.map((item) => item.id)).size !== all.length)
    fail('同一个 Spec 中的实体 ID 必须唯一');
  const evidence = new Map(spec.evidence.map((e) => [e.id, e]));
  for (const e of entities)
    if (e.evidence_ids.some((ref) => !evidence.has(ref)))
      fail(`实体 ${e.id} 引用了不存在的 Evidence`);
  for (const d of spec.decisions) {
    if (
      d.supersedes_id &&
      (d.supersedes_id === d.id || !spec.decisions.some((old) => old.id === d.supersedes_id))
    )
      fail(`决策 ${d.id} 引用了无效的旧 Decision`);
    // 产品选择必须有用户来源；项目事实应记录为边界，不能冒充用户决定。
    if (
      !d.evidence_ids.some((ref) =>
        ['user_statement', 'clarification'].includes(evidence.get(ref)?.kind ?? ''),
      )
    )
      fail(`用户决策 ${d.id} 必须引用用户陈述或澄清回答`);
  }
});
export type Specification = z.infer<typeof specificationSchema>;
export type Clock = () => string;
export const utcNow: Clock = () => new Date().toISOString();
export const newId = (prefix: string): string =>
  `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;

/** 创建精简 v2 Spec；尚未明确的目标和小细节保持为空。 */
export function createSpecification(title: string, now = utcNow()): Specification {
  return specificationSchema.parse({
    schema_version: 2,
    spec_id: newId('SP'),
    title,
    created_at: now,
    updated_at: now,
  });
}

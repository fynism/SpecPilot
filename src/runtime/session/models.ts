import { z } from 'zod';
import { emptyPlan, planFromSpec, planSchema } from '../../capabilities/clarification/plan.js';
import {
  createSpecification,
  newId,
  specificationSchema,
  timestamp,
  utcNow,
} from '../../capabilities/spec/models.js';
import { contextStateSchema, safeContextCuts } from '../context/index.js';
import { messageSchema } from '../model.js';
import { emptyTokenLedger, tokenLedgerSchema } from '../usage.js';

export const sessionIdSchema = z.string().regex(/^SS-[0-9a-f]{12}$/);
const sessionFields = z.strictObject({
  session_id: sessionIdSchema,
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((title) => title.trim().length > 0),
  status: z
    .enum(['waiting_for_user', 'running', 'interrupted', 'completed', 'failed', 'cancelled'])
    .default('waiting_for_user'),
  active_request: z.string().nullable().default(null),
  messages: z.array(messageSchema).default([]),
  spec_id: z.string(),
  spec_versions: z.array(specificationSchema).min(1),
  created_at: timestamp,
  updated_at: timestamp,
});
const sessionV4Schema = sessionFields.extend({
  schema_version: z.literal(4),
  clarification_plan: planSchema,
  context: contextStateSchema,
  token_usage: tokenLedgerSchema,
});
const currentSessionSchema = sessionV4Schema.superRefine((session, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Date.parse(session.updated_at) < Date.parse(session.created_at))
    fail('Session 更新时间不能早于创建时间');
  const context = session.context;
  if (
    context.through > 0 &&
    (!context.summary.trim() || !safeContextCuts(session.messages).includes(context.through))
  )
    fail('上下文摘要必须引用完整的历史前缀并保留配对工具');
  if (!context.through && (context.summary || context.compactions.length))
    fail('空上下文不能包含压缩记录');
  if (context.through && context.compactions.at(-1)?.source_end !== context.through)
    fail('摘要来源与压缩记录不一致');
  if (
    context.compactions.some(
      (entry, index) =>
        entry.source_end > context.through ||
        (index > 0 && entry.source_end <= (context.compactions[index - 1]?.source_end ?? 0)),
    )
  )
    fail('压缩来源必须单调递增');
  const pending = session.status === 'running' || session.status === 'interrupted';
  if (pending ? !session.active_request : session.active_request !== null)
    fail('Session 状态和 active_request 不一致');
  if (
    session.spec_versions.some(
      (spec, i) => spec.spec_id !== session.spec_id || spec.version !== i + 1,
    )
  )
    fail('Session Spec 身份及连续版本必须一致');
});
// 两个分支曾分别使用 v2；按完整严格结构区分，不能只凭版本号补字段或丢弃额外字段。
const sessionV1Schema = sessionFields.extend({ schema_version: z.literal(1).default(1) });
const clarificationV2Schema = sessionFields.extend({
  schema_version: z.literal(2),
  clarification_plan: planSchema,
});
const contextV2Schema = sessionFields.extend({
  schema_version: z.literal(2),
  context: contextStateSchema,
});
const contextV3Schema = contextV2Schema.extend({
  schema_version: z.literal(3),
  token_usage: tokenLedgerSchema,
});
/** 严格校验旧格式后统一迁移到 v4；真实消耗缺失时明确标记，不能用估算补齐。 */
function migrateLegacy(
  old: z.output<typeof sessionFields> & {
    clarification_plan?: z.output<typeof planSchema>;
    context?: z.output<typeof contextStateSchema>;
    token_usage?: z.output<typeof tokenLedgerSchema>;
  },
): z.input<typeof sessionV4Schema> {
  const latest = old.spec_versions.at(-1);
  if (!latest) throw new Error('Session 缺少 Spec 历史');
  return {
    ...old,
    schema_version: 4,
    clarification_plan: old.clarification_plan ?? planFromSpec(latest),
    context: old.context ?? contextStateSchema.parse({}),
    token_usage: old.token_usage ?? emptyTokenLedger(old.messages.length > 0),
  };
}
export const sessionSchema = z
  .union([
    sessionV4Schema,
    z
      .union([sessionV1Schema, clarificationV2Schema, contextV2Schema, contextV3Schema])
      .transform(migrateLegacy),
  ])
  .pipe(currentSessionSchema);
export type SessionRecord = z.infer<typeof sessionSchema>;

/** 每个 Session 独占空白 Spec、总览、上下文与用量，不共享可变状态。 */
export function createSessionRecord(
  title = '新对话',
  now = utcNow(),
  sessionId = newId('SS'),
): SessionRecord {
  const spec = createSpecification(title.trim(), now);
  return sessionSchema.parse({
    schema_version: 4,
    clarification_plan: emptyPlan(),
    context: contextStateSchema.parse({}),
    token_usage: emptyTokenLedger(),
    session_id: sessionId,
    title: title.trim(),
    spec_id: spec.spec_id,
    spec_versions: [spec],
    created_at: now,
    updated_at: now,
  });
}

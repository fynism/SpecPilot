import { z } from 'zod';
import { emptyPlan, planFromSpec, planSchema } from '../../capabilities/clarification/plan.js';
import {
  createSpecification,
  newId,
  specificationSchema,
  timestamp,
  utcNow,
} from '../../capabilities/spec/models.js';
import { messageSchema } from '../model.js';

export const sessionIdSchema = z.string().regex(/^SS-[0-9a-f]{12}$/);
const sessionV2Schema = z.strictObject({
  schema_version: z.literal(2),
  clarification_plan: planSchema,
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
const sessionV1Schema = sessionV2Schema.omit({ clarification_plan: true }).extend({
  schema_version: z.literal(1).default(1),
});
/** 旧快照先严格校验，再投影总览；迁移不放宽输入边界。 */
export const sessionSchema = z
  .union([
    sessionV2Schema,
    sessionV1Schema.transform((old) => {
      const latest = old.spec_versions.at(-1);
      if (!latest) throw new Error('Session 缺少 Spec 历史');
      return { ...old, schema_version: 2 as const, clarification_plan: planFromSpec(latest) };
    }),
  ])
  .superRefine((session, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (Date.parse(session.updated_at) < Date.parse(session.created_at))
      fail('Session 更新时间不能早于创建时间');
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
export type SessionRecord = z.infer<typeof sessionSchema>;

/** 每个 Session 独占空白 Spec，不共享可变消息历史。 */
export function createSessionRecord(
  title = '新对话',
  now = utcNow(),
  sessionId = newId('SS'),
): SessionRecord {
  const spec = createSpecification(title.trim(), now);
  return sessionSchema.parse({
    schema_version: 2,
    clarification_plan: emptyPlan(),
    session_id: sessionId,
    title: title.trim(),
    spec_id: spec.spec_id,
    spec_versions: [spec],
    created_at: now,
    updated_at: now,
  });
}

import { z } from 'zod';
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
const currentSessionSchema = z
  .strictObject({
    schema_version: z.literal(3).default(3),
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
    context: contextStateSchema.default(() => contextStateSchema.parse({})),
    token_usage: tokenLedgerSchema,
    spec_id: z.string(),
    spec_versions: z.array(specificationSchema).min(1),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .superRefine((session, ctx) => {
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
/** v1/v2 按需向前迁移；历史实际消耗不可重建，明确标记缺失。 */
export const sessionSchema = z.preprocess((input) => {
  if (
    typeof input === 'object' &&
    input !== null &&
    'schema_version' in input &&
    ((input.schema_version === 1 && !('context' in input)) || input.schema_version === 2) &&
    !('token_usage' in input)
  )
    return {
      ...input,
      schema_version: 3,
      ...(!('context' in input) ? { context: contextStateSchema.parse({}) } : {}),
      token_usage: emptyTokenLedger(
        'messages' in input && Array.isArray(input.messages) && input.messages.length > 0,
      ),
    };
  return input;
}, currentSessionSchema);
export type SessionRecord = z.infer<typeof sessionSchema>;

/** 每个 Session 独占空白 Spec，不共享可变消息历史。 */
export function createSessionRecord(
  title = '新对话',
  now = utcNow(),
  sessionId = newId('SS'),
): SessionRecord {
  const spec = createSpecification(title.trim(), now);
  return sessionSchema.parse({
    session_id: sessionId,
    title: title.trim(),
    token_usage: emptyTokenLedger(),
    spec_id: spec.spec_id,
    spec_versions: [spec],
    created_at: now,
    updated_at: now,
  });
}

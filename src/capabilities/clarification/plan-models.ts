import { z } from 'zod';
import { answerSchema, clarificationInputSchema } from './models.js';

export const clarificationIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const text = z.string().min(1).max(2000);
const topicSchema = z.strictObject({
  id: clarificationIdSchema,
  title: text,
  needs_detail: z.boolean(),
});
const questionShape = {
  id: clarificationIdSchema,
  topic_id: clarificationIdSchema,
  input: clarificationInputSchema.nullable(),
  statement: text,
  blocking: z.boolean(),
  depends_on: z.array(clarificationIdSchema).max(30),
  open_question_id: z.string().nullable(),
  spec_entity_ids: z.array(z.string()).max(50),
};
const questionSchema = z.strictObject({
  ...questionShape,
  version: z.number().int().positive(),
  status: z.enum(['pending', 'deferred', 'submitted', 'resolved', 'review_needed', 'inactive']),
  change_reason: text,
});
const revisionSchema = z.strictObject({
  id: clarificationIdSchema,
  question_id: clarificationIdSchema,
  question_version: z.number().int().positive(),
  answer: answerSchema,
  created_at: z.iso.datetime({ offset: true }),
  submission_id: clarificationIdSchema.nullable(),
});
const submissionSchema = z.strictObject({
  id: clarificationIdSchema,
  answer_ids: z.array(clarificationIdSchema),
  note: z.string().max(2000),
  status: z.enum(['pending', 'processed', 'retry']),
});
export const planSchema = z
  .strictObject({
    version: z.number().int().nonnegative(),
    draft_note: z.string().max(2000).default(''),
    topics: z.array(topicSchema).max(50),
    questions: z.array(questionSchema).max(200),
    rounds: z.array(
      z.strictObject({
        id: clarificationIdSchema,
        question_ids: z.array(clarificationIdSchema).max(5),
        summary: text,
      }),
    ),
    answers: z.array(revisionSchema),
    submissions: z.array(submissionSchema),
    review_entity_ids: z.array(z.string()),
  })
  .superRefine((plan, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (ids: string[]) => new Set(ids).size === ids.length;
    for (const items of [plan.topics, plan.questions, plan.rounds, plan.answers, plan.submissions])
      if (!unique(items.map((i) => i.id))) fail('澄清实体 ID 必须唯一');
    const questions = new Map(plan.questions.map((q) => [q.id, q]));
    for (const q of plan.questions) {
      if (!plan.topics.some((t) => t.id === q.topic_id)) fail('问题引用不存在的主题');
      if (!unique(q.depends_on) || q.depends_on.some((id) => !questions.has(id)))
        fail('问题依赖引用无效');
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const next of questions.get(id)?.depends_on ?? []) if (!visit(next)) return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    if (plan.questions.some((q) => !visit(q.id))) fail('问题依赖不能成环');
    for (const round of plan.rounds)
      if (!unique(round.question_ids) || round.question_ids.some((id) => !questions.has(id)))
        fail('轮次问题引用无效');
    for (const a of plan.answers) {
      if (!questions.has(a.question_id)) fail('答案问题引用无效');
      if (a.answer.request_id !== `${a.question_id}:${a.question_version}`)
        fail('答案必须绑定问题版本');
      if (a.submission_id && !plan.submissions.some((s) => s.id === a.submission_id))
        fail('答案提交引用无效');
    }
    for (const s of plan.submissions)
      if (
        !unique(s.answer_ids) ||
        s.answer_ids.some(
          (id) => !plan.answers.some((a) => a.id === id && a.submission_id === s.id),
        )
      )
        fail('提交答案引用无效');
  });
export type ClarificationPlan = z.infer<typeof planSchema>;
export type ClarificationTopic = z.infer<typeof topicSchema>;
export type ClarificationQuestion = z.infer<typeof questionSchema>;
export type ClarificationRound = ClarificationPlan['rounds'][number];
export const emptyPlan = (): ClarificationPlan =>
  planSchema.parse({
    version: 0,
    draft_note: '',
    topics: [],
    questions: [],
    rounds: [],
    answers: [],
    submissions: [],
    review_entity_ids: [],
  });

export const publishRoundSchema = z.strictObject({
  expected_version: z.number().int().nonnegative(),
  topics: z.array(topicSchema).max(50),
  questions: z
    .array(
      z.strictObject({
        ...questionShape,
        status: z.enum(['pending', 'resolved', 'inactive']),
        change_reason: text,
      }),
    )
    .max(200),
  question_ids: z.array(clarificationIdSchema).max(5),
  summary: text,
});
export type PublishRound = z.infer<typeof publishRoundSchema>;
export const editAnswerSchema = z.strictObject({
  session_id: z.string(),
  question_id: clarificationIdSchema,
  question_version: z.number().int().positive(),
  answer: answerSchema,
});

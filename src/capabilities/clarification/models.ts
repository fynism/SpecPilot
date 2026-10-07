import { z } from 'zod';

const optionId = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64);
const explanation = z.string().min(1).max(500);
export const clarificationInputSchema = z
  .strictObject({
    question: explanation,
    reason: explanation,
    options: z
      .array(
        z.strictObject({
          id: optionId,
          label: z.string().min(1).max(80),
          description: z.string().min(1).max(300),
        }),
      )
      .min(2)
      .max(5),
    recommended_option_id: optionId,
    recommendation_reason: explanation,
    allow_custom_answer: z.boolean().default(true),
  })
  .superRefine((request, ctx) => {
    const ids = request.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: '澄清选项 ID 必须唯一' });
    if (!ids.includes(request.recommended_option_id))
      ctx.addIssue({ code: 'custom', message: '推荐项必须引用已展示选项' });
  });
export type ClarificationInput = z.infer<typeof clarificationInputSchema>;
export interface ClarificationRequest extends ClarificationInput {
  request_id: string;
}
export const answerSchema = z
  .strictObject({
    request_id: z.string(),
    selected_option_id: z.string().nullable().default(null),
    free_text: z.string().min(1).max(1000).nullable().default(null),
    source: z.literal('user').default('user'),
  })
  .refine(
    (answer) => answer.selected_option_id !== null || answer.free_text !== null,
    '答案必须包含选项或自由文字',
  );
export type ClarificationAnswer = z.infer<typeof answerSchema>;
export interface ClarificationPresenter {
  ask(request: ClarificationRequest): Promise<ClarificationAnswer>;
}

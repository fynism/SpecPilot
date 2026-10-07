import { z } from 'zod';
import type { ToolSpec } from '../tooling/contracts.js';

export const textBlockSchema = z.strictObject({ type: z.literal('text'), text: z.string() });
export const toolUseSchema = z.strictObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export const toolResultSchema = z.strictObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.string(),
});
export const modelBlockSchema = z.discriminatedUnion('type', [textBlockSchema, toolUseSchema]);
export const messageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(z.union([modelBlockSchema, toolResultSchema]))]),
});
export type ModelBlock = z.infer<typeof modelBlockSchema>;
export type Message = z.infer<typeof messageSchema>;

/** 供应商无关的异步模型端口，SDK 类型仅停留在适配层。 */
export interface ModelClient {
  createMessage(
    messages: Message[],
    tools: ToolSpec[],
    system: string,
    maxTokens: number,
  ): Promise<ModelBlock[]>;
}

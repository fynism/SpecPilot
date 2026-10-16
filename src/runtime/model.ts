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

export const tokenUsageSchema = z.strictObject({
  // 输入总数已包含缓存读取和创建，不能再次相加。
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/** 供应商超限的安全分类，不携带原始请求或供应商错误正文。 */
export class ContextLimitError extends Error {
  override name = 'ContextLimitError';
}

/** 可向用户展示的安全计数错误，不包含供应商正文。 */
export class TokenCountError extends Error {
  override name = 'TokenCountError';
}

/** 供应商无关的异步模型端口，SDK 类型仅停留在适配层。 */
export interface ModelClient {
  /** 最近一次模型生成的供应商用量；缺失为 null，失败前必须清空旧值。 */
  readonly lastUsage?: TokenUsage | null;
  /** 按实际请求参数计数；接口或特定请求格式明确不支持时返回 null，由调用方标注估算。 */
  countTokens?(messages: Message[], tools: ToolSpec[], system: string): Promise<number | null>;
  createMessage(
    messages: Message[],
    tools: ToolSpec[],
    system: string,
    maxTokens: number,
  ): Promise<ModelBlock[]>;
}

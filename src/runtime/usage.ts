import { z } from 'zod';
import type { ToolSpec } from '../tooling/contracts.js';
import {
  type Message,
  type ModelBlock,
  type ModelClient,
  type TokenUsage,
  tokenUsageSchema,
} from './model.js';

const totalsSchema = tokenUsageSchema
  .extend({
    requests: z.number().int().nonnegative().safe(),
    unreported_requests: z.number().int().nonnegative().safe(),
  })
  .refine((value) => value.unreported_requests <= value.requests, '未返回用量数不能超过请求数');
export const tokenLedgerSchema = z
  .strictObject({
    total: totalsSchema,
    current_turn: totalsSchema,
    last_request: tokenUsageSchema.nullable(),
    historical_usage_unknown: z.boolean(),
  })
  .refine(
    (ledger) =>
      ledger.current_turn.input_tokens <= ledger.total.input_tokens &&
      ledger.current_turn.output_tokens <= ledger.total.output_tokens &&
      ledger.current_turn.requests <= ledger.total.requests &&
      ledger.current_turn.unreported_requests <= ledger.total.unreported_requests,
    '本次消耗不能超过累计消耗',
  );
export type TokenLedger = z.infer<typeof tokenLedgerSchema>;

/** 只统计供应商报告的消耗，历史缺失不可通过文本估算补成实际值。 */
export function emptyTokenLedger(historicalUnknown = false): TokenLedger {
  const totals = { input_tokens: 0, output_tokens: 0, requests: 0, unreported_requests: 0 };
  return {
    total: { ...totals },
    current_turn: { ...totals },
    last_request: null,
    historical_usage_unknown: historicalUnknown,
  };
}

export function addTokenUsage(ledger: TokenLedger, usage: TokenUsage | null): TokenLedger {
  if (usage) usage = tokenUsageSchema.parse(usage);
  const add = (totals: TokenLedger['total']) => ({
    input_tokens: totals.input_tokens + (usage?.input_tokens ?? 0),
    output_tokens: totals.output_tokens + (usage?.output_tokens ?? 0),
    requests: totals.requests + 1,
    unreported_requests: totals.unreported_requests + (usage ? 0 : 1),
  });
  return tokenLedgerSchema.parse({
    ...ledger,
    total: add(ledger.total),
    current_turn: add(ledger.current_turn),
    last_request: usage,
  });
}

/** 同一计量端口覆盖普通生成和压缩摘要；计数请求本身不计为模型消耗。 */
export class MeteredModelClient implements ModelClient {
  constructor(
    private readonly inner: ModelClient,
    private readonly record: (usage: TokenUsage | null) => void,
  ) {}
  get lastUsage() {
    return this.inner.lastUsage ?? null;
  }
  countTokens(messages: Message[], tools: ToolSpec[], system: string): Promise<number | null> {
    return this.inner.countTokens?.(messages, tools, system) ?? Promise.resolve(null);
  }
  async createMessage(messages: Message[], tools: ToolSpec[], system: string, maxTokens: number) {
    let blocks: ModelBlock[];
    try {
      blocks = await this.inner.createMessage(messages, tools, system, maxTokens);
    } catch (error) {
      // 失败响应/网络中断可能没有用量；显式记录未知，不复用旧统计或假定零消耗。
      this.record(this.lastUsage);
      throw error;
    }
    this.record(this.lastUsage);
    return blocks;
  }
}

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import type { Settings } from '../../config.js';
import {
  ContextLimitError,
  type Message,
  type ModelBlock,
  type ModelClient,
  modelBlockSchema,
  TokenCountError,
  type TokenUsage,
  tokenUsageSchema,
} from '../../runtime/model.js';
import type { ToolSpec } from '../../tooling/contracts.js';

const tokenCount = z.number().int().nonnegative().safe();
const providerUsageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount.nullish(),
  cache_read_input_tokens: tokenCount.nullish(),
});
function declarations(tools: ToolSpec[]): Tool[] {
  return tools.map(
    (tool): Tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: z.toJSONSchema(tool.inputSchema, {
        io: 'input',
        target: 'draft-07',
      }) as Tool['input_schema'],
    }),
  );
}

/** 官方 SDK 适配器；密钥和供应商类型不进入领域层。 */
export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  private usage: TokenUsage | null = null;
  private countingUnsupported = false;
  get lastUsage(): TokenUsage | null {
    return this.usage;
  }
  constructor(
    private readonly settings: Settings,
    client?: Anthropic,
    private readonly onUsage?: (usage: { input_tokens: number; output_tokens: number }) => void,
  ) {
    this.client =
      client ??
      new Anthropic({
        apiKey: settings.api_key,
        ...(settings.base_url ? { baseURL: settings.base_url } : {}),
      });
  }
  async countTokens(
    messages: Message[],
    tools: ToolSpec[],
    system: string,
  ): Promise<number | null> {
    if (this.countingUnsupported) return null;
    try {
      const specs = declarations(tools);
      const response = await this.client.messages.countTokens(
        {
          model: this.settings.model,
          system,
          messages: messages as MessageParam[],
          ...(specs.length ? { tools: specs } : {}),
        },
        { maxRetries: 0, timeout: 10_000 },
      );
      return tokenCount.parse(response.input_tokens);
    } catch (error) {
      if (error instanceof Anthropic.APIError && [404, 405, 501].includes(error.status ?? 0)) {
        this.countingUnsupported = true;
        return null;
      }
      throw new TokenCountError('供应商 Token 计数失败，请检查服务连接或稍后重试。', {
        cause: error,
      });
    }
  }
  async createMessage(
    messages: Message[],
    tools: ToolSpec[],
    system: string,
    maxTokens: number,
  ): Promise<ModelBlock[]> {
    this.usage = null;
    const specs = declarations(tools);
    const response = await this.client.messages
      .create({
        model: this.settings.model,
        system,
        // 内部结构已校验；供应商 SDK 的联合类型转换只留在此协议边界。
        messages: messages as MessageParam[],
        max_tokens: maxTokens,
        ...(specs.length ? { tools: specs } : {}),
      })
      .catch((error: unknown) => {
        // 仅识别明确的上下文长度错误；认证、限流和其他请求错误不触发压缩。
        if (
          error instanceof Anthropic.APIError &&
          [400, 413].includes(error.status ?? 0) &&
          /prompt is too long|context.{0,40}(?:limit|length|window)|maximum context|too many tokens/i.test(
            error.message,
          )
        )
          throw new ContextLimitError('模型上下文超过供应商限制。');
        throw error;
      });
    const usage = providerUsageSchema.safeParse(response.usage);
    if (usage.success) {
      this.usage = tokenUsageSchema.parse({
        input_tokens:
          usage.data.input_tokens +
          (usage.data.cache_creation_input_tokens ?? 0) +
          (usage.data.cache_read_input_tokens ?? 0),
        output_tokens: usage.data.output_tokens,
      });
    }
    const normalized: ModelBlock[] = [];
    if (this.onUsage) this.onUsage(response.usage);
    for (const block of response.content) {
      if (block.type === 'text')
        normalized.push(modelBlockSchema.parse({ type: 'text', text: block.text }));
      else if (block.type === 'tool_use')
        normalized.push(
          modelBlockSchema.parse({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          }),
        );
    }
    return normalized;
  }
}

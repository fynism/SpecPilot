import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import type { Settings } from '../../config.js';
import {
  type Message,
  type ModelBlock,
  type ModelClient,
  modelBlockSchema,
} from '../../runtime/model.js';
import type { ToolSpec } from '../../tooling/contracts.js';

/** 官方 SDK 适配器；密钥和供应商类型不进入领域层。 */
export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  constructor(
    private readonly settings: Settings,
    client?: Anthropic,
  ) {
    this.client =
      client ??
      new Anthropic({
        apiKey: settings.api_key,
        ...(settings.base_url ? { baseURL: settings.base_url } : {}),
      });
  }
  async createMessage(
    messages: Message[],
    tools: ToolSpec[],
    system: string,
    maxTokens: number,
  ): Promise<ModelBlock[]> {
    const declarations = tools.map(
      (tool): Tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: z.toJSONSchema(tool.inputSchema, {
          io: 'input',
          target: 'draft-07',
        }) as Tool['input_schema'],
      }),
    );
    const response = await this.client.messages.create({
      model: this.settings.model,
      system,
      // 内部结构已校验；供应商 SDK 的联合类型转换只留在此协议边界。
      messages: messages as MessageParam[],
      max_tokens: maxTokens,
      ...(declarations.length ? { tools: declarations } : {}),
    });
    const normalized: ModelBlock[] = [];
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

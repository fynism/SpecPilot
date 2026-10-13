import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import type { Message } from '../src/runtime/model.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };
const messages: Message[] = [{ role: 'user', content: '问题' }];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const response = (usage: unknown) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'fake',
  content: [{ type: 'text', text: '回答' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage,
});
const adapter = (fetch: typeof globalThis.fetch) =>
  new AnthropicModelClient(settings, new Anthropic({ apiKey: 'offline', maxRetries: 0, fetch }));

describe('真实 Token 用量与供应商计数契约', () => {
  it('读取 API 用量，缓存创建和读取全部计入上下文输入，输出保持独立', async () => {
    const client = adapter(async () =>
      json(
        response({
          input_tokens: 100,
          output_tokens: 25,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        }),
      ),
    );
    await client.createMessage(messages, [], '系统', 8000);
    expect(client.lastUsage).toEqual({ input_tokens: 600, output_tokens: 25 });
  });
  it.each([
    undefined,
    { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 10 },
    { input_tokens: '10', output_tokens: 2 },
  ])('缺失或非法 usage 不伪造真实零用量：%j', async (usage) => {
    const client = adapter(async () => json(response(usage)));
    await client.createMessage(messages, [], '系统', 8000);
    expect(client.lastUsage).toBeNull();
  });
  it('失败时清空上次用量，计数请求不覆盖生成用量', async () => {
    let count = 0;
    const client = adapter(async (url) => {
      if (String(url).includes('count_tokens')) return json({ input_tokens: 42 });
      return ++count === 1
        ? json(response({ input_tokens: 10, output_tokens: 2 }))
        : json({ error: { type: 'invalid_request_error', message: 'secret-request-data' } }, 400);
    });
    await client.createMessage(messages, [], '系统', 8000);
    expect(await client.countTokens(messages, [], '系统')).toBe(42);
    expect(client.lastUsage).toEqual({ input_tokens: 10, output_tokens: 2 });
    await expect(client.createMessage(messages, [], '系统', 8000)).rejects.toThrow();
    expect(client.lastUsage).toBeNull();
  });
  it('计数与生成使用同一模型、消息、系统提示及工具 Schema，空工具省略', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = adapter(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ input_tokens: 123 });
    });
    const tools = [
      { name: 'example', description: '示例', inputSchema: z.strictObject({ value: z.string() }) },
    ];
    expect(await client.countTokens(messages, tools, '系统')).toBe(123);
    expect(bodies[0]).toMatchObject({
      model: 'fake',
      messages,
      system: '系统',
      tools: [{ name: 'example', description: '示例', input_schema: { type: 'object' } }],
    });
    await client.countTokens(messages, [], '系统');
    expect(bodies[1]).not.toHaveProperty('tools');
  });
  it.each([404, 405, 501])('只有明确不支持的状态 %i 回退，避免重复探测', async (status) => {
    let calls = 0;
    const client = adapter(async () => {
      calls++;
      return json({ error: { type: 'not_found_error', message: 'unsupported' } }, status);
    });
    expect(await client.countTokens(messages, [], '系统')).toBeNull();
    expect(await client.countTokens(messages, [], '系统')).toBeNull();
    expect(calls).toBe(1);
  });
  it.each([401, 429, 500])('计数状态 %i 明确失败，不悄悄降级且不泄漏正文', async (status) => {
    const client = adapter(async () =>
      json({ error: { type: 'invalid_request_error', message: 'secret-token' } }, status),
    );
    await expect(client.countTokens(messages, [], '系统')).rejects.toThrow('供应商 Token 计数失败');
    await expect(client.countTokens(messages, [], '系统')).rejects.not.toThrow('secret-token');
  });
});

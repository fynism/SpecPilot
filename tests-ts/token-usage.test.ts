import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildContextUsageReader, buildSessionRuntime } from '../src/bootstrap.js';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import { contextUsageText, tokenConsumptionText } from '../src/integrations/terminal/text.js';
import { ContextManager, contextStateSchema } from '../src/runtime/context/index.js';
import type { Message } from '../src/runtime/model.js';
import { SessionManager } from '../src/runtime/session/manager.js';
import { sessionSchema } from '../src/runtime/session/models.js';
import { compactSession, runSessionTurn } from '../src/runtime/turn.js';
import { emptyTokenLedger } from '../src/runtime/usage.js';
import { call, recommendedPresenter, temporaryManager } from './helpers.js';

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

describe('实际消耗、窗口计数与恢复的离线场景 Eval', () => {
  it('用量写入短暂失败后仍保留已发生消耗，恢复点不包含未提交回答', async () => {
    const fixture = temporaryManager();
    try {
      const store = new LocalSessionStore(fixture.root);
      const manager = new SessionManager(store);
      manager.start();
      const save = store.save.bind(store);
      let failed = false;
      vi.spyOn(store, 'save').mockImplementation((record) => {
        if (!failed && record.token_usage.total.requests === 1) {
          failed = true;
          throw new Error('用量写入失败');
        }
        save(record);
      });
      const client = adapter(async (url) =>
        String(url).includes('count_tokens')
          ? json({ input_tokens: 200 })
          : json(response({ input_tokens: 200, output_tokens: 20 })),
      );
      await expect(
        runSessionTurn(
          manager,
          buildSessionRuntime(
            manager,
            fixture.root,
            settings,
            recommendedPresenter,
            () => undefined,
            client,
          ),
          '请求',
        ),
      ).rejects.toThrow('用量写入失败');
      expect(manager.current.status).toBe('interrupted');
      expect(manager.messages).toHaveLength(1);
      expect(manager.current.token_usage.total).toEqual({
        input_tokens: 200,
        output_tokens: 20,
        requests: 1,
        unreported_requests: 0,
      });
      expect(store.load(manager.current.session_id).token_usage).toEqual(
        manager.current.token_usage,
      );
    } finally {
      fixture.cleanup();
    }
  });
  it('按供应商计数而不是短文本估算触发自动压缩，摘要消耗也计入会话', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.messages.push(
        { role: 'user', content: '仅管理员，不得外传。' },
        { role: 'assistant', content: '已确认；编码未决。' },
        { role: 'user', content: '采用 UTF-8。' },
        { role: 'assistant', content: '已确认 UTF-8。' },
      );
      let taskCalls = 0;
      const client = adapter(async (url, init) => {
        const body = JSON.parse(String(init?.body));
        const summary = String(body.system).startsWith('你负责压缩对话历史');
        if (String(url).includes('count_tokens'))
          return json({
            input_tokens: summary
              ? 1000
              : String(JSON.stringify(body.messages)).includes('current_spec')
                ? 15_000
                : 493_000,
          });
        if (summary)
          return json({
            ...response({ input_tokens: 100, output_tokens: 20 }),
            content: [{ type: 'text', text: '来源消息0：仅管理员，禁止外传；编码 UTF-8 已确认。' }],
          });
        taskCalls++;
        return json(
          response({
            input_tokens: 1000,
            output_tokens: 50,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 3000,
          }),
        );
      });
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      await runSessionTurn(fixture.manager, runtime, '继续实现');
      expect(taskCalls).toBe(1);
      expect(fixture.manager.context.compactions[0]).toMatchObject({
        reason: 'automatic',
        before_tokens: 493_000,
        after_tokens: 15_000,
        before_source: 'provider',
        after_source: 'provider',
      });
      expect(fixture.manager.current.token_usage.total).toEqual({
        input_tokens: 6100,
        output_tokens: 70,
        requests: 2,
        unreported_requests: 0,
      });
      const usage = buildContextUsageReader(fixture.manager, fixture.root)();
      expect(usage).toEqual({
        usedTokens: 15_000,
        window: 500_000,
        percentage: 3,
        source: 'provider',
      });
      expect(tokenConsumptionText(fixture.manager.current.token_usage, 'zh-CN')).toContain(
        '累计 6,170 tokens',
      );
    } finally {
      fixture.cleanup();
    }
  });
  it('本地估算过大但供应商计数足够时不误压缩，新增消息使旧计数失效', async () => {
    const fixture = temporaryManager();
    try {
      const client = adapter(async (url) =>
        String(url).includes('count_tokens')
          ? json({ input_tokens: 2000 })
          : json(response({ input_tokens: 2000, output_tokens: 12 })),
      );
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      await runSessionTurn(fixture.manager, runtime, '中'.repeat(510_000));
      expect(fixture.manager.context.through).toBe(0);
      const read = buildContextUsageReader(fixture.manager, fixture.root);
      expect(read().source).toBe('provider');
      fixture.manager.messages.push({ role: 'user', content: '新增资料' });
      expect(read().source).toBe('pending');
      expect(contextUsageText(read(), 'zh-CN')).toContain('待计数');
    } finally {
      fixture.cleanup();
    }
  });
  it('失败后消费不回滚；恢复、Session 切换和新一轮统计保持隔离', async () => {
    const fixture = temporaryManager();
    try {
      let generated = 0;
      const client = adapter(async (url) => {
        if (String(url).includes('count_tokens')) return json({ input_tokens: 100 });
        if (++generated === 1)
          return json({
            ...response({ input_tokens: 100, output_tokens: 10 }),
            content: [call('r1', 'get_spec')],
            stop_reason: 'tool_use',
          });
        return json({ error: { type: 'api_error', message: 'secret-token' } }, 500);
      });
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      await expect(runSessionTurn(fixture.manager, runtime, '读取 Spec')).rejects.toThrow();
      expect(fixture.manager.current.status).toBe('interrupted');
      expect(fixture.manager.messages).toHaveLength(1);
      expect(fixture.manager.current.token_usage.total).toEqual({
        input_tokens: 100,
        output_tokens: 10,
        requests: 2,
        unreported_requests: 1,
      });
      const restored = new SessionManager(new LocalSessionStore(fixture.root));
      restored.start();
      expect(restored.current.token_usage).toEqual(fixture.manager.current.token_usage);
      const id = restored.current.session_id;
      restored.create();
      expect(restored.current.token_usage).toEqual(emptyTokenLedger());
      restored.switch(id);
      const next = adapter(async (url) =>
        String(url).includes('count_tokens')
          ? json({ input_tokens: 200 })
          : json(response({ input_tokens: 200, output_tokens: 20 })),
      );
      await runSessionTurn(
        restored,
        buildSessionRuntime(
          restored,
          fixture.root,
          settings,
          recommendedPresenter,
          () => undefined,
          next,
        ),
        '继续',
      );
      expect(restored.current.token_usage.total.input_tokens).toBe(300);
      expect(restored.current.token_usage.current_turn).toEqual({
        input_tokens: 200,
        output_tokens: 20,
        requests: 1,
        unreported_requests: 0,
      });
      expect(tokenConsumptionText(restored.current.token_usage, 'zh-CN')).toContain('不完整');
    } finally {
      fixture.cleanup();
    }
  });
  it('手动摘要被拒绝仍统计它的实际消耗，不改变消息、Spec 或生命周期', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.beginTurn('旧资料'.repeat(1000));
      fixture.manager.messages.push(
        { role: 'assistant', content: '已读取资料' },
        { role: 'user', content: '继续' },
      );
      fixture.manager.completeTurn();
      const original = fixture.manager.current;
      const client = adapter(async (url) =>
        String(url).includes('count_tokens')
          ? json({ input_tokens: 200 })
          : json({
              ...response({ input_tokens: 200, output_tokens: 20 }),
              content: [call('bad', 'apply_spec_patch')],
            }),
      );
      await expect(
        compactSession(
          fixture.manager,
          buildSessionRuntime(
            fixture.manager,
            fixture.root,
            settings,
            recommendedPresenter,
            () => undefined,
            client,
          ),
        ),
      ).rejects.toThrow('工具调用');
      expect(fixture.manager.messages).toEqual(original.messages);
      expect(fixture.manager.context).toEqual(original.context);
      expect(fixture.manager.currentSpec()).toEqual(original.spec_versions.at(-1));
      expect(fixture.manager.current.status).toBe('waiting_for_user');
      expect(fixture.manager.current.token_usage.total).toMatchObject({
        input_tokens: 200,
        output_tokens: 20,
        requests: 1,
      });
      const saved = new LocalSessionStore(fixture.root).load(original.session_id);
      expect(saved.token_usage).toEqual(fixture.manager.current.token_usage);
    } finally {
      fixture.cleanup();
    }
  });
  it('计数接口不支持时明确标注估算，实际消耗仍使用 usage', async () => {
    const fixture = temporaryManager();
    try {
      let counts = 0;
      const client = adapter(async (url) => {
        if (String(url).includes('count_tokens')) {
          counts++;
          return json({ error: { type: 'not_found_error', message: 'unsupported' } }, 404);
        }
        return json(response({ input_tokens: 300, output_tokens: 30 }));
      });
      await runSessionTurn(
        fixture.manager,
        buildSessionRuntime(
          fixture.manager,
          fixture.root,
          settings,
          recommendedPresenter,
          () => undefined,
          client,
        ),
        '需求',
      );
      const read = buildContextUsageReader(fixture.manager, fixture.root);
      expect(read().source).toBe('estimate');
      expect(contextUsageText(read(), 'zh-CN')).toContain('估算');
      expect(tokenConsumptionText(fixture.manager.current.token_usage, 'zh-CN')).toContain(
        '累计 330 tokens',
      );
      expect(counts).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
  it('usage 缺失显示未知，不把本地估算当作消耗；v2 历史无法补齐时标注缺失', async () => {
    const fixture = temporaryManager();
    try {
      const client = adapter(async (url) =>
        String(url).includes('count_tokens')
          ? json({ input_tokens: 200 })
          : json(response(undefined)),
      );
      await runSessionTurn(
        fixture.manager,
        buildSessionRuntime(
          fixture.manager,
          fixture.root,
          settings,
          recommendedPresenter,
          () => undefined,
          client,
        ),
        '需求',
      );
      expect(fixture.manager.current.token_usage.total.unreported_requests).toBe(1);
      expect(tokenConsumptionText(fixture.manager.current.token_usage, 'zh-CN')).toContain(
        '用量未知',
      );
      const legacy: Record<string, unknown> = { ...fixture.manager.current, schema_version: 2 };
      delete legacy.token_usage;
      const migrated = sessionSchema.parse(legacy);
      expect(migrated.schema_version).toBe(3);
      expect(migrated.token_usage.historical_usage_unknown).toBe(true);
      expect(sessionSchema.parse(migrated)).toEqual(migrated);
      expect(() => sessionSchema.parse({ ...migrated, token_usage: undefined })).toThrow();
      expect(() => sessionSchema.parse({ ...legacy, schema_version: '2' })).toThrow();
    } finally {
      fixture.cleanup();
    }
  });
  it('摘要请求的真实计数超限时分批，不因文本短而向模型发送超限请求', async () => {
    let state = contextStateSchema.parse({});
    const sent: number[] = [];
    const client = {
      countTokens: async (input: Message[], _tools: unknown, system: string) => {
        if (!system.startsWith('你负责压缩对话历史'))
          return input[0]?.content.toString().includes('current_spec') ? 200 : 30_000;
        const count = JSON.parse(String(input[0]?.content)).messages.length;
        return count > 1 ? 499_000 : 1000;
      },
      createMessage: async (input: Message[]) => {
        sent.push(JSON.parse(String(input[0]?.content)).messages.length);
        return [{ type: 'text' as const, text: '摘要' }];
      },
    };
    const context = new ContextManager(
      client,
      {
        read: () => state,
        write: (next) => {
          state = next;
        },
        spec: () => null,
      },
      () => undefined,
    );
    const history: Message[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `消息${i}`,
    }));
    expect(await context.compact(history, [], '系统')).toBe(true);
    expect(sent).toEqual([1, 1, 1, 1]);
  });
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

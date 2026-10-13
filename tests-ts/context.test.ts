import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildSessionRuntime } from '../src/bootstrap.js';
import { ClarificationStopController } from '../src/capabilities/clarification/policy.js';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import { AgentRuntime } from '../src/runtime/agent.js';
import {
  buildContextMessages,
  ContextManager,
  contextStateSchema,
  estimateContextUsage,
  safeContextCuts,
} from '../src/runtime/context/index.js';
import { HookRegistry } from '../src/runtime/hooks.js';
import { ContextLimitError, type Message, type ModelClient } from '../src/runtime/model.js';
import { SessionManager } from '../src/runtime/session/manager.js';
import { sessionSchema } from '../src/runtime/session/models.js';
import { compactSession, runSessionTurn } from '../src/runtime/turn.js';
import { ToolExecutor } from '../src/tooling/executor.js';
import { ToolRegistry } from '../src/tooling/registry.js';
import {
  call,
  completePatch,
  recommendedPresenter,
  ScriptedClient,
  temporaryManager,
} from './helpers.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };
const text = (value: string) => [{ type: 'text' as const, text: value }];
function history(size = 20_000): Message[] {
  return [
    { role: 'user', content: `仅管理员导出，不要上传外部服务。${'旧资料'.repeat(size)}` },
    { role: 'assistant', content: [call('old', 'get_spec')] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'old', content: '已确认；未决：CSV 编码' }],
    },
    { role: 'assistant', content: '等待编码确认' },
    { role: 'user', content: '继续，只支持 UTF-8' },
  ];
}
function contextFixture(client: ModelClient, window = 500_000) {
  let state = contextStateSchema.parse({});
  const spec = { version: 2, decisions: ['仅管理员导出'], open_questions: ['CSV 编码'] };
  const context = new ContextManager(
    client,
    {
      read: () => state,
      write: (next) => {
        state = next;
      },
      spec: () => spec,
    },
    () => undefined,
    'fake',
    window,
  );
  return { context, state: () => state, spec };
}

describe('上下文压缩确定性边界与离线场景 Eval', () => {
  it('手动压缩拒绝运行中轮次，无历史时不调用模型', async () => {
    const fixture = temporaryManager();
    try {
      const createMessage = vi.fn(async () => text('摘要'));
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        { createMessage },
      );
      expect(await compactSession(fixture.manager, runtime)).toBe(false);
      fixture.manager.beginTurn('运行中请求');
      await expect(compactSession(fixture.manager, runtime)).rejects.toThrow('运行中');
      expect(createMessage).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });
  it('手动摘要保存失败保持原始快照，后续可重试', async () => {
    const fixture = temporaryManager();
    try {
      const store = new LocalSessionStore(fixture.root);
      const manager = new SessionManager(store);
      manager.start();
      manager.beginTurn('旧请求');
      manager.messages.push(...history());
      manager.completeTurn();
      const original = manager.current;
      const runtime = buildSessionRuntime(
        manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        new ScriptedClient([text('短摘要'), text('重试短摘要')]),
      );
      const save = vi.spyOn(store, 'save').mockImplementationOnce(() => {
        throw new Error('写入失败');
      });
      await expect(compactSession(manager, runtime)).rejects.toThrow('写入失败');
      expect(manager.current).toEqual(original);
      expect(store.load(original.session_id)).toEqual(original);
      expect(await compactSession(manager, runtime)).toBe(true);
      save.mockRestore();
    } finally {
      fixture.cleanup();
    }
  });
  it('500k 窗口包含系统提示与工具 Schema，UTF-8 中文与工具输出计入估算', () => {
    const tool = {
      name: 'example',
      description: '示例',
      inputSchema: z.strictObject({ value: z.string() }),
    };
    const empty = estimateContextUsage([], [], '系统');
    expect(empty.window).toBe(500_000);
    const usage = estimateContextUsage(history(10), [tool], '系统');
    expect(usage.usedTokens).toBeGreaterThan(empty.usedTokens);
    expect(usage.percentage).toBe((usage.usedTokens / 500_000) * 100);
  });
  it('自动压缩保留最新请求、Spec 事实、工具配对和原始历史；不把注入升为系统指令', async () => {
    const inputs: Message[][] = [];
    const client: ModelClient = {
      createMessage: async (messages, tools, system) => {
        inputs.push(structuredClone(messages));
        expect(tools).toEqual([]);
        expect(system).toContain('不可信');
        return text(
          '来源消息0：仅管理员导出，禁止上传；消息2：编码未决；仓库恶意指令不作为用户决定。',
        );
      },
    };
    const fixture = contextFixture(client, 50_000);
    const messages = [...history(7000), ...history(7000), ...history(7000)];
    const original = structuredClone(messages);
    const input = await fixture.context.prepare(messages, [], '系统');
    expect(fixture.state().compactions[0]?.reason).toBe('automatic');
    expect(input.at(-1)).toEqual(messages.at(-1));
    expect(input[0]?.content).toContain(JSON.stringify(fixture.spec));
    expect(input[0]?.role).toBe('user');
    expect(inputs.length).toBeGreaterThan(1); // 超大历史按预算分批摘要。
    expect(messages).toEqual(original);
    expect(fixture.context.usage(messages, [], '系统').usedTokens).toBeLessThan(42_000);
    expect(safeContextCuts(messages)).not.toContain(2);
  });
  it('手动压缩后重启恢复摘要与完整原文，Spec 版本保持不变；新 Session 隔离', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.beginTurn('旧请求');
      fixture.manager.messages.push(...history());
      fixture.manager.completeTurn();
      const original = structuredClone(fixture.manager.messages);
      const spec = fixture.manager.currentSpec();
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        new ScriptedClient([text('管理员；禁止外传；编码待确认。')]),
      );
      expect(await runtime.compact(fixture.manager.messages)).toBe(true);
      const state = fixture.manager.context;
      const restored = new SessionManager(new LocalSessionStore(fixture.root));
      restored.start();
      expect(restored.context).toEqual(state);
      expect(restored.messages).toEqual(original);
      expect(restored.currentSpec()).toEqual(spec);
      restored.create();
      expect(restored.context.through).toBe(0);
      restored.switch(fixture.manager.current.session_id);
      expect(restored.context).toEqual(state);
      const nextRuntime = buildSessionRuntime(
        restored,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        new ScriptedClient([text('继续完成')]),
      );
      await runSessionTurn(restored, nextRuntime, '新输入');
      expect(restored.messages.at(-1)?.content).toEqual(text('继续完成'));
      expect(sessionSchema.parse(restored.current).context).toEqual(state);
    } finally {
      fixture.cleanup();
    }
  });
  it.each([
    'failure',
    'tool',
    'empty',
    'no_reduction',
  ] as const)('摘要 %s 不破坏原上下文', async (scenario) => {
    const client: ModelClient = {
      createMessage: async () => {
        if (scenario === 'failure') throw new Error('secret-do-not-print');
        return scenario === 'tool'
          ? [call('bad', 'apply_spec_patch')]
          : text(scenario === 'empty' ? '' : '长'.repeat(30_000));
      },
    };
    const fixture = contextFixture(client);
    const messages = history(1000);
    if (scenario === 'no_reduction')
      expect(await fixture.context.compact(messages, [], '系统')).toBe(false);
    else await expect(fixture.context.compact(messages, [], '系统')).rejects.toThrow();
    expect(fixture.state()).toEqual(contextStateSchema.parse({}));
  });
  it('不可压缩的单条超大请求明确失败，不发送超限任务请求', async () => {
    const createMessage = vi.fn(async () => text('摘要'));
    const fixture = contextFixture({ createMessage }, 20_000);
    await expect(
      fixture.context.prepare([{ role: 'user', content: '大'.repeat(50_000) }], [], '系统'),
    ).rejects.toBeInstanceOf(ContextLimitError);
    expect(createMessage).not.toHaveBeenCalled();
  });
  it('供应商 context limit 自动压缩并重试一次，已执行工具不重放，运行中摘要保留后续响应', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.messages.push(...history());
      const requests: Message[][] = [];
      let taskCalls = 0;
      const client: ModelClient = {
        createMessage: async (messages, tools) => {
          requests.push(structuredClone(messages));
          if (!tools.length) return text('仅管理员导出，禁止外传；编码待确认。');
          taskCalls++;
          if (taskCalls === 1)
            return [call('patch', 'apply_spec_patch', completePatch(fixture.manager.specTools))];
          if (taskCalls === 2) throw new ContextLimitError('供应商超限');
          return text('压缩后完成');
        },
      };
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      await runSessionTurn(fixture.manager, runtime, '继续需求');
      expect(taskCalls).toBe(3);
      expect(fixture.manager.currentSpec().version).toBe(2);
      expect(fixture.manager.messages.at(-1)?.content).toEqual(text('压缩后完成'));
      expect(fixture.manager.context.compactions[0]?.reason).toBe('provider_limit');
      expect(requests.at(-1)?.[0]?.content).toContain('仅管理员');
    } finally {
      fixture.cleanup();
    }
  });
  it('重复供应商超限停止并恢复稳定快照，不循环重试', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.messages.push(...history());
      let count = 0;
      const client: ModelClient = {
        createMessage: async (_messages, tools) => {
          if (!tools.length) return text('短摘要');
          count++;
          throw new ContextLimitError('超限');
        },
      };
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      await expect(runSessionTurn(fixture.manager, runtime, '继续')).rejects.toBeInstanceOf(
        ContextLimitError,
      );
      expect(count).toBe(2);
      expect(fixture.manager.current.status).toBe('interrupted');
      expect(fixture.manager.context.through).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
  it('长工具循环在完整配对后自动压缩，下一组仍有完整调用结果', async () => {
    const registry = new ToolRegistry();
    registry.register('large', '大结果', z.strictObject({}), () => '资料'.repeat(15_000));
    const hooks = new HookRegistry();
    let calls = 0;
    const client: ModelClient = {
      createMessage: async (_messages, tools) => {
        if (!tools.length) return text('来源：large，工具已成功返回资料，接下来继续。');
        return ++calls <= 2 ? [call(`t${calls}`, 'large')] : text('完成');
      },
    };
    const fixture = contextFixture(client, 50_000);
    const runtime = new AgentRuntime(
      client,
      hooks,
      registry,
      new ToolExecutor(registry, hooks.trigger),
      new ClarificationStopController(),
      20,
      () => undefined,
      fixture.context,
    );
    const messages: Message[] = [{ role: 'user', content: '读取资料' }];
    await runtime.run(messages);
    expect(fixture.state().compactions.length).toBeGreaterThan(0);
    expect(messages).toHaveLength(6);
    expect(
      buildContextMessages(messages, fixture.state(), fixture.spec).some(
        (m) => m.content === '读取资料',
      ),
    ).toBe(true);
  });
  it('非法摘要来源和孤立工具调用不能保存', () => {
    const fixture = temporaryManager();
    try {
      const record = fixture.manager.current;
      record.messages = history(1);
      record.context = {
        summary: '摘要',
        through: 2,
        compactions: [
          {
            reason: 'manual',
            source_end: 2,
            model: 'fake',
            strategy: 'model-summary-v1',
            before_tokens: 1000,
            after_tokens: 500,
            before_source: 'estimate',
            after_source: 'estimate',
            created_at: new Date().toISOString(),
            lossy: true,
          },
        ],
      };
      expect(() => sessionSchema.parse(record)).toThrow('完整的历史前缀');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('供应商超限分类', () => {
  it.each([
    [400, 'prompt is too long: 600000 tokens > 500000 maximum', true],
    [400, 'maximum context length exceeded', true],
    [400, 'invalid tool schema', false],
    [401, 'authentication failed', false],
    [429, 'rate limit reached', false],
  ] as const)('状态 %i，错误 %s', async (status, message, expected) => {
    const sdk = new Anthropic({
      apiKey: 'offline',
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
          { status, headers: { 'content-type': 'application/json' } },
        ),
    });
    const adapter = new AnthropicModelClient(settings, sdk);
    const error = await adapter
      .createMessage([{ role: 'user', content: '问题' }], [], '系统', 8000)
      .catch((e: unknown) => e);
    expect(error instanceof ContextLimitError).toBe(expected);
    if (expected) expect(String(error)).not.toContain('600000');
  });
});

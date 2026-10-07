import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSessionRuntime } from '../src/bootstrap.js';
import {
  answerSchema,
  type ClarificationPresenter,
  clarificationInputSchema,
} from '../src/capabilities/clarification/models.js';
import { isClarificationStopRequest } from '../src/capabilities/clarification/policy.js';
import {
  ClarificationCancelled,
  ClarificationService,
} from '../src/capabilities/clarification/tool.js';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import { HookRegistry } from '../src/runtime/hooks.js';
import type { Message } from '../src/runtime/model.js';
import { runSessionTurn } from '../src/runtime/turn.js';
import { ToolExecutor } from '../src/tooling/executor.js';
import { ToolRegistry } from '../src/tooling/registry.js';
import {
  call,
  clarification,
  completePatch,
  recommendedPresenter,
  ScriptedClient,
  temporaryManager,
} from './helpers.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };
describe('统一 Tool 管线与 Hook', () => {
  it('拒绝未知、额外字段和隐式转换，执行前 Hook 短路，失败不泄漏异常密钥', async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    const hooks = new HookRegistry();
    registry.register('example', '测试', z.strictObject({ value: z.number().int() }), () => {
      events.push('handler');
      return '完成';
    });
    expect(() => registry.register('example', '测试', z.strictObject({}), () => '')).toThrow();
    const executor = new ToolExecutor(registry, hooks.trigger);
    expect(await executor.execute('unknown', {})).toContain('Error:');
    expect(await executor.execute('example', { value: '1' })).toContain('参数无效');
    expect(await executor.execute('example', { value: 1, extra: true })).toContain('参数无效');
    hooks.register('PreToolUse', () => {
      events.push('pre');
    });
    hooks.register('PostToolUse', () => {
      events.push('post');
    });
    expect(await executor.execute('example', { value: 1 })).toBe('完成');
    expect(events).toEqual(['pre', 'handler', 'post']);
    hooks.register('PreToolUse', () => '拒绝');
    hooks.register('PreToolUse', () => {
      throw new Error('不该执行');
    });
    expect(await executor.execute('example', { value: 1 })).toBe('拒绝');
    registry.register('fails', '测试失败', z.strictObject({}), () => {
      throw new Error('secret-token');
    });
    const error = await new ToolExecutor(registry, () => undefined).execute('fails', {});
    expect(error).toContain('Error:');
    expect(error).not.toContain('secret-token');
  });
  it('安全 Hook 异常不会放行处理函数', async () => {
    const registry = new ToolRegistry();
    let executed = false;
    const hooks = new HookRegistry();
    registry.register('example', '测试', z.strictObject({}), () => {
      executed = true;
      return '';
    });
    hooks.register('PreToolUse', () => {
      throw new Error('策略不可用');
    });
    await expect(
      new ToolExecutor(registry, hooks.trigger).execute('example', {}),
    ).rejects.toThrow();
    expect(executed).toBe(false);
  });
});

describe('澄清信任与结束边界', () => {
  it.each([
    '/done',
    '到此为止。',
    '好的，到此为止！',
    '先到这里',
    '停止澄清',
  ])('识别完整结束语 %s', (text) => expect(isClarificationStopRequest(text)).toBe(true));
  it.each([
    '结束澄清按钮需要确认',
    '不要停止澄清',
    '到此为止，但再调查一下',
    '好的',
  ])('业务句子不会误停止 %s', (text) => expect(isClarificationStopRequest(text)).toBe(false));
  it('选项唯一、推荐项存在，空答案和无授权自由回答被拒绝', async () => {
    expect(() =>
      clarificationInputSchema.parse({ ...clarification, recommended_option_id: 'missing' }),
    ).toThrow();
    expect(() =>
      clarificationInputSchema.parse({
        ...clarification,
        options: [clarification.options[0], clarification.options[0]],
      }),
    ).toThrow();
    expect(() => answerSchema.parse({ request_id: 'Q-test' })).toThrow();
    for (const presenter of [
      {
        ask: async () =>
          answerSchema.parse({ request_id: 'other', selected_option_id: 'recommended' }),
      },
      {
        ask: async (r: Parameters<ClarificationPresenter['ask']>[0]) =>
          answerSchema.parse({ request_id: r.request_id, selected_option_id: 'missing' }),
      },
      {
        ask: async (r: Parameters<ClarificationPresenter['ask']>[0]) =>
          answerSchema.parse({ request_id: r.request_id, free_text: '未经允许' }),
      },
    ])
      await expect(
        new ClarificationService(presenter).request({
          ...clarification,
          allow_custom_answer: false,
        }),
      ).rejects.toThrow();
  });
  it('取消只发布取消事件，组合答案保持原文并每次生成新请求 ID', async () => {
    const events: string[] = [];
    const cancelled = new ClarificationService(
      {
        ask: async () => {
          throw new ClarificationCancelled();
        },
      },
      (event) => {
        events.push(event);
      },
    );
    expect(JSON.parse(await cancelled.request(clarification)).answer).toBeNull();
    expect(events).toEqual(['ClarificationRequested', 'ClarificationCancelled']);
    const service = new ClarificationService({
      ask: async (r) =>
        answerSchema.parse({
          request_id: r.request_id,
          selected_option_id: 'recommended',
          free_text: '限制为本页',
        }),
    });
    const first = JSON.parse(await service.request(clarification));
    const second = JSON.parse(await service.request(clarification));
    expect(first.request_id).not.toBe(second.request_id);
    expect(first.answer.free_text).toBe('限制为本页');
  });
});

describe('离线 Agent 端到端', () => {
  it('Stop Hook 可以要求一次确定性收尾，再把控制权交还用户', async () => {
    const fixture = temporaryManager();
    try {
      const client = new ScriptedClient([
        [{ type: 'text', text: '初次回答' }],
        [{ type: 'text', text: '收尾完成' }],
      ]);
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      runtime.hooks.register('Stop', () =>
        client.exposedTools.length === 1 ? '请完成收尾检查' : undefined,
      );
      expect(await runSessionTurn(fixture.manager, runtime, '需求')).toBe('model_complete');
      expect(fixture.manager.messages[2]).toEqual({ role: 'user', content: '请完成收尾检查' });
      expect(fixture.manager.current.status).toBe('waiting_for_user');
    } finally {
      fixture.cleanup();
    }
  });
  it('调查、两次澄清、Patch、校验与导出，工具调用 ID 成对并保存完整 Session', async () => {
    const fixture = temporaryManager();
    try {
      writeFileSync(join(fixture.root, 'roles.txt'), 'admin\nmember\n');
      const client = new ScriptedClient([
        [call('1', 'list_repository_files'), call('2', 'search_repository', { query: 'admin' })],
        [call('3', 'read_repository_file', { path: 'roles.txt' })],
        [call('4', 'request_clarification', clarification)],
        [call('5', 'request_clarification', clarification)],
        [call('6', 'get_spec')],
        [call('7', 'apply_spec_patch', completePatch(fixture.manager.specTools))],
        [call('8', 'validate_spec')],
        [call('9', 'export_spec')],
        [{ type: 'text', text: '需求澄清完成' }],
      ]);
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      expect(await runSessionTurn(fixture.manager, runtime, '增加导出')).toBe('model_complete');
      expect(fixture.manager.current.status).toBe('waiting_for_user');
      expect(fixture.manager.currentSpec().version).toBe(2);
      const results = fixture.manager.messages.flatMap((m) =>
        typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_result'),
      );
      expect(results.map((r) => r.tool_use_id)).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
      ]);
      expect(results.every((r) => !r.content.startsWith('Error:'))).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            join(
              fixture.root,
              `.specpilot/specs/${fixture.manager.currentSpec().spec_id}/spec.json`,
            ),
            'utf8',
          ),
        ).version,
      ).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });
  it('工具预算按模型轮次计数，完整结果后暂停', async () => {
    const fixture = temporaryManager();
    try {
      const client = new ScriptedClient([[call('1', 'get_spec'), call('2', 'validate_spec')]]);
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        { ...settings, max_tool_use_turns: 1 },
        recommendedPresenter,
        () => undefined,
        client,
      );
      expect(await runSessionTurn(fixture.manager, runtime, '继续')).toBe('max_tool_use_turns');
      const last = fixture.manager.messages.at(-1);
      expect(Array.isArray(last?.content) && last.content.length).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });
  it.each(['/done', '到此为止。'])('结束语 %s 不公开工具且拒绝异常 tool_use', async (query) => {
    const fixture = temporaryManager();
    try {
      const client = new ScriptedClient([
        [call('bad', 'apply_spec_patch', completePatch(fixture.manager.specTools))],
        [{ type: 'text', text: '已有信息总结' }],
      ]);
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      await runSessionTurn(fixture.manager, runtime, query);
      expect(client.exposedTools).toEqual([[], []]);
      expect(fixture.manager.currentSpec().version).toBe(1);
      expect(client.systems.every((system) => system.includes('No tools are available'))).toBe(
        true,
      );
    } finally {
      fixture.cleanup();
    }
  });
  it('澄清中结束立即禁用同批余下工具，预算上限也保留最终总结', async () => {
    const fixture = temporaryManager();
    try {
      const presenter: ClarificationPresenter = {
        ask: async (r) => answerSchema.parse({ request_id: r.request_id, free_text: '到此为止' }),
      };
      const client = new ScriptedClient([
        [
          call('q', 'request_clarification', clarification),
          call('bad', 'apply_spec_patch', completePatch(fixture.manager.specTools)),
        ],
        [{ type: 'text', text: '最终总结' }],
      ]);
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        { ...settings, max_tool_use_turns: 1 },
        presenter,
        () => undefined,
        client,
      );
      expect(await runSessionTurn(fixture.manager, runtime, '澄清')).toBe('model_complete');
      expect(client.exposedTools[0]).toHaveLength(8);
      expect(client.exposedTools[1]).toEqual([]);
      expect(fixture.manager.currentSpec().version).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
  it('模型失败回到稳定中断状态，可恢复后继续', async () => {
    const fixture = temporaryManager();
    try {
      const client = new ScriptedClient([[call('1', 'get_spec')]]);
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      await expect(runSessionTurn(fixture.manager, runtime, '需求')).rejects.toThrow();
      expect(fixture.manager.current.status).toBe('interrupted');
      expect(fixture.manager.messages).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Anthropic 适配器离线协议', () => {
  it('声明 Zod 输入 Schema，空工具集完全省略，响应转换不依赖 SDK 对象', async () => {
    const bodies: Record<string, unknown>[] = [];
    const sdk = new Anthropic({
      apiKey: 'offline',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'fake',
            content: [
              { type: 'text', text: '回答', citations: [] },
              { type: 'tool_use', id: 't1', name: 'example', input: {} },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const adapter = new AnthropicModelClient(settings, sdk);
    const messages: Message[] = [{ role: 'user', content: '问题' }];
    expect(await adapter.createMessage(messages, [], '系统', 8000)).toEqual([
      { type: 'text', text: '回答' },
      call('t1', 'example'),
    ]);
    expect(bodies[0]).not.toHaveProperty('tools');
    const registry = new ToolRegistry();
    registry.register(
      'example',
      '示例',
      z.strictObject({ optional: z.string().default('default') }),
      () => '',
    );
    await adapter.createMessage(messages, registry.toolSpecs(), '系统', 8000);
    expect(JSON.stringify(bodies[1]?.tools)).toContain('additionalProperties');
  });
});

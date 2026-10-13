import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answerSchema } from '../src/capabilities/clarification/models.js';
import {
  ClarificationStopController,
  isClarificationStopRequest,
} from '../src/capabilities/clarification/policy.js';
import { entityFields } from '../src/capabilities/spec/models.js';
import { loadSettings } from '../src/config.js';
import { loadEvalCases, scoreTrace } from '../src/evaluation/scoring.js';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import { AgentRuntime } from '../src/runtime/agent.js';
import { HookRegistry } from '../src/runtime/hooks.js';
import type { ModelBlock } from '../src/runtime/model.js';
import { buildDefaultRegistry } from '../src/tooling/catalog.js';
import type { ToolCall } from '../src/tooling/contracts.js';
import { ToolExecutor } from '../src/tooling/executor.js';
import {
  buildLegacySessionRuntime as buildSessionRuntime,
  call,
  clarification,
  completePatch,
  recommendedPresenter,
  ScriptedClient,
  temporaryManager,
} from './helpers.js';

const cases = loadEvalCases(resolve('evals/cases.json'));
const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };
const names = {
  goals: 'goal',
  scope: 'scope',
  requirements: 'requirement',
  decisions: 'decision',
  assumptions: 'assumption',
  open_questions: 'open_question',
  acceptance_criteria: 'acceptance_criterion',
  evidence: 'evidence',
} as const;

describe('六个原有场景的离线执行契约与评分', () => {
  it('数据集类别、fixture 和四项评分保持兼容', () => {
    expect(cases).toHaveLength(6);
    expect(new Set(cases.map((c) => c.category)).size).toBe(6);
    expect(cases.every((c) => existsSync(resolve(c.fixture)))).toBe(true);
    const scenario = cases[2];
    if (!scenario) throw new Error('缺少场景');
    expect(
      scoreTrace(scenario, {
        tools: ['search_repository', 'read_repository_file', 'apply_spec_patch'],
        clarification_count: 0,
        spec_entities: ['evidence', 'requirement'],
      }).passed,
    ).toBe(true);
    expect(
      scoreTrace(scenario, {
        tools: ['request_clarification'],
        clarification_count: 1,
        spec_entities: [],
      }).checks_passed,
    ).toBe(0);
  });
  it.each(cases)('受控模型脚本实际执行工具并验证轨迹：$id', async (scenario) => {
    const fixture = temporaryManager();
    try {
      cpSync(resolve(scenario.fixture), fixture.root, { recursive: true });
      const file =
        scenario.id === 'repository_prompt_injection' ? 'requirements.txt' : 'project.json';
      const patch = completePatch(fixture.manager.specTools);
      const responses: ModelBlock[][] = scenario.expectation.required_tools
        .filter((tool) => tool !== 'apply_spec_patch' && tool !== 'validate_spec')
        .map((tool, i) => [
          call(
            `e${i}`,
            tool,
            tool === 'search_repository'
              ? { query: 'export' }
              : tool === 'read_repository_file'
                ? { path: file }
                : tool === 'request_clarification'
                  ? clarification
                  : {},
          ),
        ]);
      if (scenario.id !== 'explicit_clarification_stop') {
        if (scenario.id === 'low_impact_filename')
          patch.operations = [
            {
              op: 'put_assumption',
              id: 'A-001',
              statement: '导出文件名使用 export.csv',
              confidence: 0.8,
              impact: '低影响可修改',
              invalidation_condition: '用户提出新的命名要求',
            },
          ];
        responses.push([call('patch', 'apply_spec_patch', patch)]);
        if (scenario.expectation.required_tools.includes('validate_spec'))
          responses.push([call('validate', 'validate_spec')]);
      }
      responses.push([{ type: 'text', text: '受控场景完成' }]);
      const calls: string[] = [];
      let count = 0;
      const runtime = buildSessionRuntime(
        fixture.manager,
        fixture.root,
        settings,
        {
          ask: async (request) => {
            count++;
            return recommendedPresenter.ask(request);
          },
        },
        () => undefined,
        new ScriptedClient(responses),
      );
      runtime.hooks.register('PreToolUse', (input) => {
        calls.push((input as ToolCall).name);
      });
      fixture.manager.beginTurn(scenario.user_input);
      await runtime.run(fixture.manager.messages, !isClarificationStopRequest(scenario.user_input));
      fixture.manager.completeTurn();
      const spec = fixture.manager.currentSpec();
      const score = scoreTrace(scenario, {
        tools: calls,
        clarification_count: count,
        spec_entities: [...entityFields, 'evidence' as const]
          .filter((field) => spec[field].length)
          .map((field) => names[field]),
      });
      expect(score.violations).toEqual([]);
      const results = fixture.manager.messages.flatMap((m) =>
        typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_result'),
      );
      expect(results.every((r) => !r.content.startsWith('Error:'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

// 保留原付费 Eval 开关；默认测试绝不访问真实模型或凭据。
it.skipIf(process.env.SPECPILOT_RUN_LIVE_EVALS !== '1')(
  '显式启用的真实模型导出需求 Eval',
  async () => {
    const fixture = temporaryManager();
    try {
      const scenario = cases[0];
      if (!scenario) throw new Error('缺少场景');
      cpSync(resolve(scenario.fixture), fixture.root, { recursive: true });
      const settings = loadSettings(resolve('.'));
      const inner = new AnthropicModelClient(settings);
      let modelCalls = 0;
      let clarificationCount = 0;
      const calls: string[] = [];
      const hooks = new HookRegistry();
      const stop = new ClarificationStopController();
      hooks.register('PreToolUse', (input) => {
        calls.push((input as ToolCall).name);
      });
      hooks.register('ClarificationAnswered', (_request, answer) => {
        stop.observeAnswer(answer);
      });
      const registry = buildDefaultRegistry(
        fixture.root,
        fixture.manager.specTools,
        {
          ask: async (request) => {
            clarificationCount++;
            return answerSchema.parse({
              request_id: request.request_id,
              selected_option_id: request.recommended_option_id,
            });
          },
        },
        hooks.trigger,
      );
      const runtime = new AgentRuntime(
        {
          createMessage: async (...args) => {
            if (++modelCalls > 12) throw new Error('真实 Eval 超过最大模型轮次');
            return inner.createMessage(...args);
          },
        },
        hooks,
        registry,
        new ToolExecutor(registry, hooks.trigger),
        stop,
        settings.max_tool_use_turns,
        () => undefined,
      );
      fixture.manager.beginTurn(scenario.user_input);
      await runtime.run(fixture.manager.messages);
      const spec = fixture.manager.currentSpec();
      expect(
        scoreTrace(scenario, {
          tools: calls,
          clarification_count: clarificationCount,
          spec_entities: [...entityFields, 'evidence' as const]
            .filter((field) => spec[field].length)
            .map((field) => names[field]),
        }).violations,
      ).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  },
  180000,
);

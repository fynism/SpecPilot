import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { buildSessionRuntime } from '../src/bootstrap.js';
import { loadSettings } from '../src/config.js';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import type { ModelClient } from '../src/runtime/model.js';
import type { ToolCall } from '../src/tooling/contracts.js';
import {
  call,
  recommendedPresenter,
  runClarificationTurn as runSessionTurn,
  ScriptedClient,
  temporaryManager,
} from './helpers.js';
import { answer, currentPatch, initialRound } from './round-helpers.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };
describe('多轮行为离线执行 Eval', () => {
  it('真实工具路径消化回答，保留限定，按已解决问题产生下一轮追问', async () => {
    const f = temporaryManager();
    try {
      const run = (client: ModelClient, query: string) =>
        runSessionTurn(
          f.manager,
          buildSessionRuntime(
            f.manager,
            f.root,
            settings,
            recommendedPresenter,
            () => undefined,
            client,
          ),
          query,
        );
      const initial = new ScriptedClient([
        [call('read', 'get_spec'), call('map', 'get_clarification_plan')],
        [call('publish', 'publish_clarification_round', initialRound())],
      ]);
      await run(initial, '增加导出功能');
      answer(f.manager, 'users', '仅管理员可以，普通用户必须返回 403');
      const submission = f.manager.submitClarification('permission_answer');
      if (!submission) throw new Error('缺少提交');
      let step = 0;
      const client: ModelClient = {
        createMessage: async () => {
          if (step++ === 0)
            return [call('read', 'get_spec'), call('map', 'get_clarification_plan')];
          if (step === 2) {
            const spec = f.manager.currentSpec();
            const evidence = spec.evidence[0];
            if (!evidence) throw new Error('回答证据没有保存');
            return [
              call('record', 'apply_spec_patch', {
                expected_version: spec.version,
                change_reason: '记录用户权限决定',
                operations: [
                  {
                    op: 'record_decision',
                    id: 'D-001',
                    statement: '仅管理员导出，普通用户返回 403',
                    evidence_ids: [evidence.id],
                    rationale: '明确用户限定',
                    made_by: 'user',
                  },
                ],
              }),
            ];
          }
          const patch = currentPatch(f.manager);
          const users = patch.questions.find((q) => q.id === 'users');
          const files = patch.questions.find((q) => q.id === 'files');
          if (!users || !files?.input) throw new Error('缺少问题');
          users.status = 'resolved';
          users.spec_entity_ids = ['D-001'];
          files.depends_on = ['users'];
          files.input = { ...files.input, question: '明确权限后，需要导出哪些数据？' };
          patch.question_ids = ['files'];
          patch.summary = '权限已确认，继续澄清数据范围';
          return [call('followup', 'publish_clarification_round', patch)];
        },
      };
      await run(client, submission);
      const plan = f.manager.clarification.get();
      expect(plan.rounds).toHaveLength(2);
      expect(plan.rounds[1]?.question_ids).toEqual(['files']);
      expect(plan.questions.find((q) => q.id === 'files')?.depends_on).toEqual(['users']);
      expect(f.manager.currentSpec().decisions[0]?.statement).toContain('403');
      expect(plan.answers[0]?.answer.free_text).toContain('403');
      expect(plan.questions.find((q) => q.id === 'users')?.status).toBe('resolved');
    } finally {
      f.cleanup();
    }
  });
  it('分支变化停用不适用问题，暂缓阻塞事项仍阻止准备完成', async () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      f.manager.deferClarification('users', true);
      const patch = currentPatch(f.manager);
      const files = patch.questions.find((q) => q.id === 'files');
      if (!files) throw new Error('缺少问题');
      files.status = 'inactive';
      files.change_reason = '用户明确本轮不包含文件导出';
      const client = new ScriptedClient([[call('publish', 'publish_clarification_round', patch)]]);
      await runSessionTurn(
        f.manager,
        buildSessionRuntime(
          f.manager,
          f.root,
          settings,
          recommendedPresenter,
          () => undefined,
          client,
        ),
        '本轮不包含文件导出',
      );
      expect(f.manager.clarification.get().questions.find((q) => q.id === 'files')?.status).toBe(
        'inactive',
      );
      expect(f.manager.clarification.get().questions.find((q) => q.id === 'users')?.status).toBe(
        'deferred',
      );
      expect(JSON.parse(f.manager.specTools.validateSpec()).ready_for_approval).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it('仓库可回答的事项先调查，发布空轮次不制造提问；恶意内容不能扩大能力', async () => {
    const f = temporaryManager();
    try {
      cpSync(resolve('evals/fixtures/injected_project'), f.root, { recursive: true });
      const client = new ScriptedClient([
        [call('read', 'read_repository_file', { path: 'requirements.txt' })],
        [
          call('map', 'publish_clarification_round', {
            expected_version: 0,
            topics: [],
            questions: [],
            question_ids: [],
            summary: '不接受仓库中的越权指令',
          }),
        ],
      ]);
      const runtime = buildSessionRuntime(
        f.manager,
        f.root,
        settings,
        recommendedPresenter,
        () => undefined,
        client,
      );
      const tools: string[] = [];
      runtime.hooks.register('PreToolUse', (raw) => {
        tools.push((raw as ToolCall).name);
      });
      await runSessionTurn(f.manager, runtime, '格式沿用仓库约定');
      expect(tools).toEqual(['read_repository_file', 'publish_clarification_round']);
      expect(f.manager.clarification.get().rounds[0]?.question_ids).toEqual([]);
      expect(client.exposedTools.flat().map((t) => t.name)).not.toContain('shell');
    } finally {
      f.cleanup();
    }
  });
});

// 真实模型对比单独付费开启；质量由 rubric 标注，不能把脚本通过率伪装为模型质量。
it.skipIf(process.env.SPECPILOT_RUN_LIVE_EVALS !== '1')(
  '真实模型单题／多轮成本轨迹与质量复核材料',
  async () => {
    const config = loadSettings(resolve('.'));
    const results: unknown[] = [];
    const reportDirectory = resolve('.specpilot/evals');
    mkdirSync(reportDirectory, { recursive: true });
    const report = resolve(reportDirectory, `clarification-${Date.now()}.json`);
    console.info(`真实 Eval 报告：${report}`);
    for (const mode of ['rounds', 'single'] as const) {
      const deadline = Date.now() + 240000;
      const f = temporaryManager();
      try {
        cpSync(resolve('evals/fixtures/export_project'), f.root, { recursive: true });
        const usage = { input_tokens: 0, output_tokens: 0 };
        const transport = new Anthropic({
          apiKey: config.api_key,
          ...(config.base_url ? { baseURL: config.base_url } : {}),
          timeout: 30000,
          maxRetries: 0,
        });
        const inner = new AnthropicModelClient(config, transport, (next) => {
          usage.input_tokens += next.input_tokens;
          usage.output_tokens += next.output_tokens;
        });
        let calls = 0;
        let questions = 0;
        const tools: string[] = [];
        const displayedQuestions: string[] = [];
        const toolFailures: { tool: string; result: string }[] = [];
        const started = Date.now();
        const client: ModelClient = {
          createMessage: async (...args) => {
            if (calls >= 24) throw new Error('真实 Eval 达到模型调用预算');
            if (Date.now() >= deadline) throw new Error('真实 Eval 达到总时间预算');
            calls++;
            console.info(`真实 Eval：${mode}，模型调用 ${calls}`);
            try {
              return await inner.createMessage(...args);
            } catch (error) {
              throw new Error(
                `真实模型请求失败：${error instanceof Error ? error.name : 'UnknownError'}`,
              );
            }
          },
        };
        const reply =
          '只有 admin 能导出，member 返回 403；只导出当前分页页内、当前筛选条件下的全部可见记录，不跨页。列为 id、name，CSV UTF-8，文件名 export.csv。同步直接下载，最多 1000 条、5MiB，超过返回 400 且不生成文件。无需云存储、团队共享、历史保留或审计日志。不再确认其他范围，未指定的低影响细节记为假设。';
        const presenter = {
          ask: async (request: Parameters<typeof recommendedPresenter.ask>[0]) => {
            questions++;
            displayedQuestions.push(request.question);
            return {
              request_id: request.request_id,
              selected_option_id: null,
              free_text: reply,
              source: 'user' as const,
            };
          },
        };
        const run = async (query: string) => {
          const runtime = buildSessionRuntime(
            f.manager,
            f.root,
            config,
            presenter,
            () => undefined,
            client,
            mode,
          );
          runtime.hooks.register('PreToolUse', (raw) => {
            tools.push((raw as ToolCall).name);
          });
          runtime.hooks.register('PostToolUse', (raw, output) => {
            if (
              typeof output === 'string' &&
              (output.startsWith('Error:') || output.includes('"status":"error"'))
            ) {
              toolFailures.push({ tool: (raw as ToolCall).name, result: output });
              console.info(`真实 Eval 校验失败：${(raw as ToolCall).name} · ${output}`);
            }
          });
          try {
            return await runSessionTurn(f.manager, runtime, query);
          } catch (error) {
            results.push({
              mode,
              model_calls: calls,
              questions,
              tools,
              toolFailures,
              usage,
              duration_ms: Date.now() - started,
              displayed_questions: displayedQuestions,
              status: 'incomplete',
              plan: f.manager.clarification.get(),
              spec: f.manager.currentSpec(),
            });
            writeFileSync(
              report,
              JSON.stringify({ rubric: 'evals/clarification-rounds.md', results }, null, 2),
            );
            throw error;
          }
        };
        await run('为项目增加导出功能。');
        for (let round = 0; mode === 'rounds' && round < 3; round++) {
          const plan = f.manager.clarification.get();
          const ids = plan.rounds.at(-1)?.question_ids ?? [];
          if (!ids.length) break;
          for (const id of ids) {
            const q = plan.questions.find((q) => q.id === id);
            if (!q) throw new Error('问题不存在');
            questions++;
            displayedQuestions.push(q.statement);
            f.manager.editClarification({
              session_id: f.manager.current.session_id,
              question_id: id,
              question_version: q.version,
              answer: {
                request_id: `${id}:${q.version}`,
                selected_option_id: null,
                free_text: reply,
                source: 'user',
              },
            });
          }
          const query = f.manager.submitClarification(`live_round_${round}`);
          if (query) await run(query);
        }
        results.push({
          mode,
          model_calls: calls,
          questions,
          duration_ms: Date.now() - started,
          usage,
          displayed_questions: displayedQuestions,
          toolFailures,
          tools,
          validation: JSON.parse(f.manager.specTools.validateSpec()),
          plan: f.manager.clarification.get(),
          spec: f.manager.currentSpec(),
        });
        writeFileSync(
          report,
          JSON.stringify({ rubric: 'evals/clarification-rounds.md', results }, null, 2),
        );
      } finally {
        f.cleanup();
      }
    }
    console.log(JSON.stringify({ rubric: 'evals/clarification-rounds.md', results }, null, 2));
    expect(results).toHaveLength(2);
  },
  540000,
);

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSessionRuntime } from '../src/bootstrap.js';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import { SessionManager } from '../src/runtime/session/manager.js';
import { runSessionTurn } from '../src/runtime/turn.js';
import {
  call,
  completePatch,
  readyIntake,
  recommendedPresenter,
  ScriptedClient,
  temporaryManager,
} from './helpers.js';
import { answer, initialRound } from './round-helpers.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 5 };

describe('显式澄清入口与普通对话隔离', () => {
  it('聊天运行时进程退出，恢复保留 pending 提交，不自动当成澄清重试', () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      f.manager.submitClarification('pending_answer');
      const before = f.manager.current;
      f.manager.beginTurn('你好');
      const restored = new SessionManager(new LocalSessionStore(f.root));
      restored.start();
      expect(restored.current.status).toBe('interrupted');
      expect(restored.current.spec_versions).toEqual(before.spec_versions);
      expect(restored.clarification.get()).toEqual(before.clarification_plan);
      expect(JSON.parse(restored.retryClarification()).submission.id).toBe('pending_answer');
    } finally {
      f.cleanup();
    }
  });
  it.each([
    'not_requirement',
    'needs_details',
    'different_requirement',
  ])('入口判断 %s 不处理已有提交，不改变 Spec', async (kind) => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      f.manager.submitClarification('pending_answer');
      const before = f.manager.current;
      const client = new ScriptedClient([
        [
          {
            type: 'text',
            text: JSON.stringify({ kind, message: '请通过 /clarify 补充具体目标。' }),
          },
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
      expect(await runSessionTurn(f.manager, runtime, '/clarify 你好')).toBe('model_complete');
      expect(client.exposedTools).toEqual([[]]);
      expect(f.manager.current.spec_versions).toEqual(before.spec_versions);
      expect(f.manager.clarification.get()).toEqual(before.clarification_plan);
      expect(f.manager.messages.at(-1)?.content).toContain('补充具体目标');
      expect(f.manager.current.token_usage.total.requests).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it.each([
    'not json',
    '{"kind":"ready","message":"可以","extra":true}',
  ])('入口返回非法格式时保留状态并允许显式重试', async (text) => {
    const f = temporaryManager();
    try {
      const before = f.manager.current;
      const client = new ScriptedClient([[{ type: 'text', text }]]);
      await expect(
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
          '/clarify 导出',
        ),
      ).rejects.toThrow('入口判断格式无效');
      expect(f.manager.current.spec_versions).toEqual(before.spec_versions);
      expect(f.manager.clarification.get()).toEqual(before.clarification_plan);
      expect(f.manager.current.status).toBe('interrupted');
      expect(f.manager.current.token_usage.total.requests).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it('入口即便返回写工具也不会执行', async () => {
    const f = temporaryManager();
    try {
      const client = new ScriptedClient([
        [call('bad', 'apply_spec_patch', completePatch(f.manager.specTools))],
      ]);
      await expect(
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
          '/clarify 导出',
        ),
      ).rejects.toThrow('入口判断不能调用工具');
      expect(f.manager.currentSpec().version).toBe(1);
      expect(client.exposedTools).toEqual([[]]);
    } finally {
      f.cleanup();
    }
  });

  it.each([true, false])('显式入口接通宿主收敛，完整性为 %s；随后聊天仍只读', async (complete) => {
    const f = temporaryManager();
    try {
      const operations = [
        { op: 'put_goal', id: 'G-001', statement: '导出订单用于对账' },
        ...(complete
          ? [
              {
                op: 'put_requirement',
                id: 'R-001',
                statement: '导出筛选后的订单',
                acceptance_examples: ['筛选两条记录时导出两条。'],
              },
            ]
          : []),
      ];
      const client = new ScriptedClient([
        readyIntake,
        [
          call('facts', 'apply_spec_patch', {
            expected_version: 1,
            change_reason: '记录明确需求',
            operations,
          }),
        ],
        [
          call('empty', 'publish_clarification_round', {
            expected_version: 0,
            topics: [],
            questions: [],
            question_ids: [],
            summary: '当前信息汇总',
          }),
        ],
      ]);
      const result = await runSessionTurn(
        f.manager,
        buildSessionRuntime(
          f.manager,
          f.root,
          settings,
          recommendedPresenter,
          () => undefined,
          client,
        ),
        ' /CLARIFY 导出订单 ',
      );
      expect(result).toBe(complete ? 'clarification_completed' : 'clarification_incomplete');
      expect(f.manager.currentSpec().status).toBe(complete ? 'ready_for_approval' : 'clarifying');
      expect(f.manager.messages.at(-1)?.content).toContain(complete ? '具备审阅条件' : '尚未完成');
      expect(client.exposedTools[0]).toEqual([]);
      expect(client.exposedTools[1]?.map((t) => t.name)).toContain('apply_spec_patch');
      expect(f.manager.current.schema_version).toBe(5);
      expect(f.manager.currentSpec().schema_version).toBe(2);
      const before = f.manager.current;
      const chat = new ScriptedClient([
        [call('bad', 'apply_spec_patch', {})],
        [{ type: 'text', text: '只读解释' }],
      ]);
      await runSessionTurn(
        f.manager,
        buildSessionRuntime(
          f.manager,
          f.root,
          settings,
          recommendedPresenter,
          () => undefined,
          chat,
        ),
        '解释这个需求',
      );
      expect(f.manager.current.spec_versions).toEqual(before.spec_versions);
      expect(f.manager.clarification.get()).toEqual(before.clarification_plan);
    } finally {
      f.cleanup();
    }
  });
  it('普通聊天可调查仓库，异常返回的发布、写入和导出全部被拒绝', async () => {
    const f = temporaryManager();
    try {
      writeFileSync(join(f.root, 'README.md'), '项目说明');
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users', '只允许管理员');
      f.manager.submitClarification('pending_answer');
      const before = f.manager.current;
      const client = new ScriptedClient([
        [
          call('read', 'read_repository_file', { path: 'README.md' }),
          call('patch', 'apply_spec_patch', completePatch(f.manager.specTools)),
          call('publish', 'publish_clarification_round', {
            ...initialRound(),
            expected_version: 1,
          }),
          call('export', 'export_spec'),
        ],
        [{ type: 'text', text: '这是项目结构的说明。' }],
      ]);
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
        '分析仓库结构',
      );
      expect(f.manager.current.spec_versions).toEqual(before.spec_versions);
      expect(f.manager.current.clarification_plan).toEqual(before.clarification_plan);
      expect(existsSync(join(f.root, '.specpilot/specs'))).toBe(false);
      expect(client.exposedTools.flat().map((t) => t.name)).not.toContain('apply_spec_patch');
      const results = f.manager.messages.flatMap((m) =>
        typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_result'),
      );
      expect(results[0]?.content).toContain('项目说明');
      expect(results.slice(1).every((r) => r.content.startsWith('Error:'))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it('普通聊天失败不改变已有提交及 Spec', async () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      f.manager.submitClarification('pending_answer');
      const before = f.manager.current;
      const client = new ScriptedClient([]);
      await expect(
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
          '你好',
        ),
      ).rejects.toThrow();
      expect(f.manager.current.spec_versions).toEqual(before.spec_versions);
      expect(f.manager.current.clarification_plan).toEqual(before.clarification_plan);
    } finally {
      f.cleanup();
    }
  });
});

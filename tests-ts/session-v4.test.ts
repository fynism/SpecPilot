import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContextUsageReader, buildSessionRuntime } from '../src/bootstrap.js';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import { estimateContextUsage } from '../src/runtime/context/index.js';
import type { Message, ModelClient } from '../src/runtime/model.js';
import { CHAT_SYSTEM, ROUND_SYSTEM } from '../src/runtime/prompts.js';
import { SessionManager } from '../src/runtime/session/manager.js';
import { sessionSchema } from '../src/runtime/session/models.js';
import { compactSession } from '../src/runtime/turn.js';
import {
  call,
  recommendedPresenter,
  runClarificationTurn as runSessionTurn,
  temporaryManager,
} from './helpers.js';
import { answer, initialRound } from './round-helpers.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };

function longHistory(manager: SessionManager): void {
  manager.beginTurn(`只允许管理员导出。${'旧仓库资料'.repeat(3000)}`);
  manager.messages.push(
    { role: 'assistant', content: '已读取资料' },
    { role: 'user', content: '保留未决问题' },
    { role: 'assistant', content: '等待回答' },
    { role: 'user', content: '继续澄清' },
    { role: 'assistant', content: '已准备' },
  );
  manager.completeTurn();
}

describe('Session v5 新目录与组合离线 Eval', () => {
  it('拒绝旧格式并保留旧目录内容', async () => {
    const f = temporaryManager();
    try {
      const legacy = JSON.parse(
        readFileSync(new URL('./fixtures/python-session-v1.json', import.meta.url), 'utf8'),
      );
      const directory = join(f.root, '.specpilot/sessions', legacy.session_id);
      const path = join(directory, 'session.json');
      const bytes = JSON.stringify(legacy);
      (await import('node:fs')).mkdirSync(directory, { recursive: true });
      writeFileSync(path, bytes);
      const store = new LocalSessionStore(f.root);
      expect(() => store.load(legacy.session_id)).toThrow('Session 不存在');
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(f.manager.current.schema_version).toBe(5);
    } finally {
      f.cleanup();
    }
  });

  it('拒绝不完整或混合的旧格式，以及缺失核心字段的 v4', () => {
    const f = temporaryManager();
    try {
      const record = f.manager.current;
      expect(() => sessionSchema.parse({ ...record, schema_version: 2 })).toThrow();
      expect(() => sessionSchema.parse({ ...record, schema_version: 3 })).toThrow();
      for (const field of ['clarification_plan', 'context', 'token_usage']) {
        const incomplete: Record<string, unknown> = { ...record };
        delete incomplete[field];
        expect(() => sessionSchema.parse(incomplete)).toThrow();
      }
    } finally {
      f.cleanup();
    }
  });

  it('发布暂停、草稿、压缩、重启和下一轮提交共存；计数使用实际提示词与工具', async () => {
    const f = temporaryManager();
    try {
      longHistory(f.manager);
      const client: ModelClient = {
        lastUsage: { input_tokens: 11, output_tokens: 7 },
        countTokens: async (messages, tools, system) => {
          if (tools.length && system === ROUND_SYSTEM) {
            expect(tools.map((tool) => tool.name)).toContain('publish_clarification_round');
            expect(tools.map((tool) => tool.name)).not.toContain('request_clarification');
          } else if (tools.length) {
            expect(system).toBe(CHAT_SYSTEM);
            expect(tools.map((tool) => tool.name)).not.toContain('publish_clarification_round');
          }
          return estimateContextUsage(messages, tools, system).usedTokens;
        },
        createMessage: async (_messages, tools) =>
          tools.length
            ? [
                call('publish', 'publish_clarification_round', initialRound()),
                call('blocked', 'get_spec'),
              ]
            : [{ type: 'text', text: '旧资料摘要：仅管理员导出；未决问题从总览读取。' }],
      };
      const runtime = () =>
        buildSessionRuntime(
          f.manager,
          f.root,
          settings,
          recommendedPresenter,
          () => undefined,
          client,
        );
      expect(await runSessionTurn(f.manager, runtime(), '准备澄清')).toBe(
        'clarification_round_ready',
      );
      expect(buildContextUsageReader(f.manager, f.root)().source).toBe('provider');
      const result = f.manager.messages.at(-1)?.content;
      expect(Array.isArray(result) && result[1]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'blocked',
        content: expect.stringContaining('后续工具调用被拒绝'),
      });
      answer(f.manager, 'users', '仅管理员，必须保留审计');
      f.manager.setClarificationNote('未提交补充');
      const plan = f.manager.clarification.get();
      const messages = structuredClone(f.manager.messages);
      expect(await compactSession(f.manager, runtime())).toBe(true);
      expect(f.manager.messages).toEqual(messages);
      expect(f.manager.clarification.get()).toEqual(plan);
      expect(buildContextUsageReader(f.manager, f.root)().source).toBe('provider');
      const restored = new SessionManager(new LocalSessionStore(f.root));
      restored.start();
      expect(restored.context).toEqual(f.manager.context);
      expect(restored.current.clarification_plan).toEqual(plan);
      expect(restored.current.token_usage.total.requests).toBe(2);
      expect(buildContextUsageReader(restored, f.root)().source).toBe('pending');
      const query = restored.submitClarification('submit_after_compaction');
      if (!query) throw new Error('缺少提交');
      const next: ModelClient = {
        lastUsage: { input_tokens: 13, output_tokens: 5 },
        createMessage: async (input) => {
          expect(String(input[0]?.content)).toContain('current_spec');
          expect(restored.clarification.get().answers[0]?.answer.free_text).toBe(
            '仅管理员，必须保留审计',
          );
          expect(restored.currentSpec().evidence.some((e) => e.kind === 'clarification')).toBe(
            true,
          );
          return [{ type: 'text', text: '已读取真实提交，可继续调查与追问' }];
        },
      };
      await runSessionTurn(
        restored,
        buildSessionRuntime(
          restored,
          f.root,
          settings,
          recommendedPresenter,
          () => undefined,
          next,
        ),
        query,
      );
      expect(restored.current.token_usage.total.requests).toBe(3);
      expect(restored.current.token_usage.current_turn.requests).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it('失败后保留提交与真实消耗，丢弃未提交的压缩', async () => {
    const f = temporaryManager();
    try {
      longHistory(f.manager);
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      const query = f.manager.submitClarification('failed_submission');
      if (!query) throw new Error('缺少提交');
      const beforePlan = f.manager.current.clarification_plan;
      let attempts = 0;
      const client: ModelClient = {
        lastUsage: { input_tokens: 20, output_tokens: 3 },
        countTokens: async (messages, tools, system) => {
          if (
            !system.startsWith('你负责压缩对话历史') &&
            !String(messages[0]?.content).includes('current_spec')
          )
            return 499_000;
          return estimateContextUsage(messages, tools, system).usedTokens;
        },
        createMessage: async (_messages: Message[], _tools, system) => {
          attempts++;
          if (system.startsWith('你负责压缩对话历史'))
            return [{ type: 'text', text: '仅管理员导出，未决问题需继续澄清。' }];
          f.manager.setClarificationNote('运行中禁止编辑');
          throw new Error('模型调用失败');
        },
      };
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
          query,
        ),
      ).rejects.toThrow('运行中不能编辑');
      expect(attempts).toBe(2);
      expect(f.manager.current.status).toBe('interrupted');
      expect(f.manager.context.through).toBe(0);
      expect(f.manager.current.token_usage.total.requests).toBe(2);
      expect(f.manager.current.token_usage.total.input_tokens).toBe(40);
      expect(f.manager.current.clarification_plan.answers).toEqual(beforePlan.answers);
      expect(f.manager.current.clarification_plan.submissions[0]?.status).toBe('retry');
      const restored = new SessionManager(new LocalSessionStore(f.root));
      restored.start();
      expect(restored.current.token_usage).toEqual(f.manager.current.token_usage);
      expect(restored.current.clarification_plan).toEqual(f.manager.current.clarification_plan);
    } finally {
      f.cleanup();
    }
  });
});

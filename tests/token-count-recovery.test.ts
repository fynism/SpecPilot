import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { buildContextUsageReader, buildSessionRuntime } from '../src/bootstrap.js';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import type { ModelBlock } from '../src/runtime/model.js';
import { runSessionTurn } from '../src/runtime/turn.js';
import { call, recommendedPresenter, temporaryManager } from './helpers.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 5 };
function provider(
  reply: (generation: number) => ModelBlock[],
  failCount: (generation: number) => boolean,
) {
  let generations = 0;
  const sdk = new Anthropic({
    apiKey: 'offline',
    fetch: async (url) => {
      const count = String(url).includes('count_tokens');
      const failed = count && failCount(generations);
      const body = count
        ? failed
          ? { error: { type: 'api_error', message: 'private-provider-detail' } }
          : { input_tokens: 100 }
        : {
            id: `msg_${++generations}`,
            type: 'message',
            role: 'assistant',
            model: 'fake',
            content: reply(generations),
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 10 },
          };
      return new Response(JSON.stringify(body), {
        status: failed ? 503 : 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client: new AnthropicModelClient(settings, sdk), generations: () => generations };
}

describe('回答完成与 Token 计数失败的恢复边界', () => {
  it.each(['你好', '/done'])('回答已显示后计数失败仍保存完整回答：%s', async (query) => {
    const f = temporaryManager();
    try {
      let failing = true;
      let visible = false;
      const notices: string[] = [];
      const p = provider(
        () => [{ type: 'text', text: '这是已经完成的回答。' }],
        (n) => n > 0 && failing,
      );
      const runtime = () =>
        buildSessionRuntime(
          f.manager,
          f.root,
          settings,
          recommendedPresenter,
          (notice) => {
            notices.push(notice);
            if (notice === '模型响应已接收。')
              visible = f.manager.messages.at(-1)?.role === 'assistant';
          },
          p.client,
        );
      await expect(runSessionTurn(f.manager, runtime(), query)).resolves.toBe('model_complete');
      expect(visible).toBe(true);
      expect(f.manager.current.status).toBe('waiting_for_user');
      expect(f.manager.messages.at(-1)?.content).toEqual([
        { type: 'text', text: '这是已经完成的回答。' },
      ]);
      expect(new LocalSessionStore(f.root).load(f.manager.current.session_id).messages).toEqual(
        f.manager.messages,
      );
      expect(f.manager.current.token_usage.total.requests).toBe(1);
      expect(buildContextUsageReader(f.manager, f.root)().source).toBe('pending');
      expect(notices.join('\n')).toContain('计数暂不可用');
      expect(notices.join('\n')).toContain('HTTP 503');
      expect(notices.join('\n')).not.toContain('private-provider-detail');
      await expect(runSessionTurn(f.manager, runtime(), '服务未恢复时继续')).rejects.toThrow(
        '供应商 Token 计数失败',
      );
      expect(p.generations()).toBe(1);
      expect(f.manager.messages[1]?.content).toEqual([
        { type: 'text', text: '这是已经完成的回答。' },
      ]);
      failing = false;
      await expect(runSessionTurn(f.manager, runtime(), '继续聊天')).resolves.toBe(
        'model_complete',
      );

      expect(f.manager.current.token_usage.total.requests).toBe(2);
      expect(buildContextUsageReader(f.manager, f.root)().source).toBe('provider');
    } finally {
      f.cleanup();
    }
  });

  it('入口拒绝后的展示计数失败也保存回复，不将无关内容误当作中断需求', async () => {
    const f = temporaryManager();
    try {
      const p = provider(
        () => [
          {
            type: 'text',
            text: JSON.stringify({ kind: 'not_requirement', message: '请提供想梳理的需求。' }),
          },
        ],
        (n) => n > 0,
      );
      expect(
        await runSessionTurn(
          f.manager,
          buildSessionRuntime(
            f.manager,
            f.root,
            settings,
            recommendedPresenter,
            () => undefined,
            p.client,
          ),
          '/clarify 你好',
        ),
      ).toBe('model_complete');
      expect(f.manager.current.status).toBe('waiting_for_user');
      expect(f.manager.messages.at(-1)?.content).toBe('请提供想梳理的需求。');
      expect(f.manager.currentSpec().version).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it('空轮次发布后的计数失败不回滚 Spec 和自然完成摘要', async () => {
    const f = temporaryManager();
    try {
      const p = provider(
        (n) =>
          n === 1
            ? [
                call('facts', 'apply_spec_patch', {
                  expected_version: 1,
                  change_reason: '记录需求',
                  operations: [
                    { op: 'put_goal', id: 'G-001', statement: '导出订单' },
                    {
                      op: 'put_requirement',
                      id: 'R-001',
                      statement: '导出筛选订单',
                      acceptance_examples: ['两条记录导出两条。'],
                    },
                  ],
                }),
              ]
            : [
                call('publish', 'publish_clarification_round', {
                  expected_version: 0,
                  topics: [],
                  questions: [],
                  question_ids: [],
                  summary: '订单导出已明确',
                }),
              ],
        (n) => n >= 2,
      );
      expect(
        await runSessionTurn(
          f.manager,
          buildSessionRuntime(
            f.manager,
            f.root,
            settings,
            recommendedPresenter,
            () => undefined,
            p.client,
          ),
          '宿主提交明确需求',
          'clarification',
        ),
      ).toBe('clarification_completed');
      expect(f.manager.current.status).toBe('waiting_for_user');
      expect(f.manager.currentSpec().status).toBe('ready_for_approval');
      expect(f.manager.messages.at(-1)?.content).toContain('需求已具备审阅条件');
      const stored = new LocalSessionStore(f.root).load(f.manager.current.session_id);
      expect(stored.clarification_plan.rounds).toHaveLength(1);
      expect(stored.spec_versions.at(-1)?.status).toBe('ready_for_approval');
      expect(stored.messages).toEqual(f.manager.messages);
    } finally {
      f.cleanup();
    }
  });

  it('发送前计数失败仍阻止模型请求，不使用估算静默放行', async () => {
    const f = temporaryManager();
    try {
      const p = provider(
        () => [{ type: 'text', text: '不应生成' }],
        () => true,
      );
      await expect(
        runSessionTurn(
          f.manager,
          buildSessionRuntime(
            f.manager,
            f.root,
            settings,
            recommendedPresenter,
            () => undefined,
            p.client,
          ),
          '你好',
        ),
      ).rejects.toThrow('供应商 Token 计数失败');
      expect(p.generations()).toBe(0);
      expect(f.manager.current.status).toBe('interrupted');
    } finally {
      f.cleanup();
    }
  });

  it('工具循环尚未完成时计数失败仍中断，不把中间响应伪装成成功', async () => {
    const f = temporaryManager();
    try {
      const p = provider(
        () => [call('read', 'get_spec')],
        (n) => n > 0,
      );
      await expect(
        runSessionTurn(
          f.manager,
          buildSessionRuntime(
            f.manager,
            f.root,
            settings,
            recommendedPresenter,
            () => undefined,
            p.client,
          ),
          '解释当前需求',
        ),
      ).rejects.toThrow('供应商 Token 计数失败');
      expect(p.generations()).toBe(1);
      expect(f.manager.current.status).toBe('interrupted');
      expect(f.manager.messages).toEqual([{ role: 'user', content: '解释当前需求' }]);
    } finally {
      f.cleanup();
    }
  });
});

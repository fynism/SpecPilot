import { describe, expect, it } from 'vitest';
import { buildSessionRuntime } from '../src/bootstrap.js';
import { renderSpecMarkdown } from '../src/capabilities/spec/export.js';
import { createSpecification, specificationSchema } from '../src/capabilities/spec/models.js';
import { patchSchema, SpecToolService } from '../src/capabilities/spec/operations.js';
import { runSessionTurn } from '../src/runtime/turn.js';
import { call, recommendedPresenter, ScriptedClient, temporaryManager } from './helpers.js';
import { initialRound } from './round-helpers.js';

const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };
const content = [
  { op: 'put_goal', id: 'G-001', statement: '导出订单用于对账' },
  {
    op: 'put_requirement',
    id: 'R-001',
    statement: '导出当前筛选结果',
    acceptance_examples: ['筛选得到两条订单时，文件恰好包含这两条订单。'],
  },
];

describe('精简 Spec 与宿主收敛门禁', () => {
  it('新事实源只保留单一目标、边界、需求、决策和内部证据', () => {
    expect(createSpecification('导出')).toMatchObject({
      schema_version: 2,
      goal: null,
      boundaries: [],
      requirements: [],
      decisions: [],
      evidence: [],
    });
    expect(() =>
      specificationSchema.parse({ ...createSpecification('导出'), assumptions: [] }),
    ).toThrow();
    for (const status of ['ready_for_approval', 'approved'])
      expect(() =>
        patchSchema.parse({
          expected_version: 1,
          change_reason: '模型不能声明就绪',
          operations: [{ op: 'set_spec_metadata', status }],
        }),
      ).toThrow();
  });

  it('验收直接属于需求，导出省略空边界、决策和内部证据章节', () => {
    const service = SpecToolService.create();
    service.applySpecPatch(
      patchSchema.parse({
        expected_version: 1,
        change_reason: '记录明确需求',
        operations: content,
      }),
    );
    const markdown = renderSpecMarkdown(service.currentSpec());
    expect(markdown).toContain('## 需求');
    expect(markdown).toContain('## 验收示例');
    expect(markdown).toContain('这两条订单');
    for (const title of ['## 边界与约束', '## 产品决策', '## 证据', '## 假设', '## 未决问题'])
      expect(markdown).not.toContain(title);
  });

  it.each([1, 2, 3])('一轮可发布 %i 个独立问题，四题被拒绝', (count) => {
    const f = temporaryManager();
    try {
      const first = initialRound();
      const template = first.questions[0];
      if (!template) throw new Error('缺少问题');
      first.questions = Array.from({ length: count }, (_, i) => ({
        ...template,
        id: `question_${i}`,
      }));
      first.question_ids = first.questions.map((q) => q.id);
      f.manager.clarification.publish(first);
      const next = {
        ...first,
        expected_version: 1,
        question_ids: ['question_0', 'question_1', 'question_2', 'question_3'],
      };
      expect(() => f.manager.clarification.publish(next)).toThrow();
    } finally {
      f.cleanup();
    }
  });

  it.each([true, false])('空轮次仅在需求与验收完整时由宿主设置待复核：%s', async (complete) => {
    const f = temporaryManager();
    try {
      const operations = complete ? content : content.slice(0, 1);
      const client = new ScriptedClient([
        [
          call('facts', 'apply_spec_patch', {
            expected_version: 1,
            change_reason: '澄清结果',
            operations,
          }),
        ],
        [
          call('publish', 'publish_clarification_round', {
            expected_version: 0,
            topics: [],
            questions: [],
            question_ids: [],
            summary: complete ? '核心行为与验收已明确，可复核。' : '尚缺行为与验收，暂未就绪。',
          }),
        ],
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
        '导出订单',
      );
      expect(f.manager.currentSpec().status).toBe(complete ? 'ready_for_approval' : 'clarifying');
      expect(f.manager.currentSpec().status).not.toBe('approved');
      expect(f.manager.current.schema_version).toBe(5);
    } finally {
      f.cleanup();
    }
  });
});

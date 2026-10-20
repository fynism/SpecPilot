import { describe, expect, it } from 'vitest';
import {
  emptyPlan,
  planSchema,
  publishRoundSchema,
} from '../src/capabilities/clarification/plan-models.js';
import { clarification } from './helpers.js';

describe('跨轮澄清结构契约', () => {
  it('严格校验 ID、问题依赖与轮次引用，不接受未知字段', () => {
    const plan = emptyPlan();
    expect(() => planSchema.parse({ ...plan, extra: true })).toThrow();
    plan.topics.push({ id: 'scope', title: '范围', needs_detail: false });
    plan.questions.push({
      id: 'users',
      topic_id: 'scope',
      input: clarification,
      statement: '使用者',
      blocking: true,
      depends_on: ['missing'],
      spec_entity_ids: [],
      version: 1,
      status: 'pending',
      change_reason: '准备问题',
    });
    expect(() => planSchema.parse(plan)).toThrow('依赖');
    plan.questions[0]?.depends_on.splice(0);
    plan.rounds.push({ id: 'round_one', question_ids: ['missing'], summary: '基本问题' });
    expect(() => planSchema.parse(plan)).toThrow('引用');
  });
  it('发布接口不能注入答案或草稿，每轮至多五题', () => {
    const publish = {
      expected_version: 0,
      topics: [],
      questions: [],
      question_ids: [],
      summary: '初始总览',
    };
    expect(publishRoundSchema.parse(publish)).toEqual(publish);
    expect(() => publishRoundSchema.parse({ ...publish, answers: [] })).toThrow();
    expect(() =>
      publishRoundSchema.parse({ ...publish, question_ids: Array(6).fill('users') }),
    ).toThrow();
  });
});

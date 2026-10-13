import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import type { SessionManager } from '../src/runtime/session/manager.js';
import { SessionManager as PersistentManager } from '../src/runtime/session/manager.js';
import { completePatch, required, temporaryManager } from './helpers.js';
import { answer, currentPatch, initialRound } from './round-helpers.js';

function ground(manager: SessionManager, id: string, decisionId = 'D-001') {
  const a = manager.clarification
    .get()
    .answers.filter((a) => a.question_id === id)
    .at(-1);
  if (!a) throw new Error('缺少答案');
  const spec = manager.currentSpec();
  const evidence = required(spec.evidence.find((e) => e.locator === `clarification:${a.id}`));
  manager.specTools.applySpecPatch({
    expected_version: spec.version,
    change_reason: '记录用户确认',
    operations: [
      {
        op: 'record_decision',
        id: decisionId,
        statement: '仅管理员导出',
        evidence_ids: [evidence.id],
        rationale: '用户明确选择',
        made_by: 'user',
        supersedes_id: null,
      },
    ],
  });
}

describe('多轮澄清领域状态', () => {
  it('补充说明提交生成真实证据，可解决问题且不伪造表单答案', () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      const query = required(f.manager.submitClarification('note_one', '仅管理员可以导出'));
      f.manager.beginTurn(query);
      const spec = f.manager.currentSpec();
      const evidence = required(
        spec.evidence.find((e) => e.locator === 'clarification-note:note_one'),
      );
      f.manager.specTools.applySpecPatch({
        expected_version: spec.version,
        change_reason: '记录明确补充',
        operations: [
          {
            op: 'record_decision',
            id: 'D-001',
            statement: '仅管理员导出',
            evidence_ids: [evidence.id],
            made_by: 'user',
            rationale: '用户明确补充',
            supersedes_id: null,
          },
        ],
      });
      const patch = currentPatch(f.manager);
      required(patch.questions[0]).status = 'resolved';
      required(patch.questions[0]).spec_entity_ids = ['D-001'];
      f.manager.clarification.publish(patch);
      f.manager.completeTurn();
      expect(f.manager.clarification.get().questions[0]?.status).toBe('resolved');
      expect(f.manager.clarification.get().answers).toEqual([]);
      expect(() =>
        f.manager.specTools.applySpecPatch({
          expected_version: f.manager.currentSpec().version,
          change_reason: '模型不能制造宿主证据',
          operations: [
            {
              op: 'record_evidence',
              id: 'E-099',
              kind: 'clarification',
              summary: '伪造答复',
              locator: 'clarification:ANSWER-fake',
            },
          ],
        }),
      ).toThrow('宿主');
    } finally {
      f.cleanup();
    }
  });
  it('保存运行起点失败时回滚宿主证据，并保持既有服务的 Store 引用', () => {
    const f = temporaryManager();
    try {
      const store = new LocalSessionStore(f.root);
      const manager = new PersistentManager({
        save: (record) => {
          if (record.status === 'running') throw new Error('模拟保存失败');
          store.save(record);
        },
        load: (id) => store.load(id),
        listSessions: () => store.listSessions(),
        activeSessionId: () => store.activeSessionId(),
        setActive: (id) => store.setActive(id),
      });
      manager.start();
      manager.clarification.publish(initialRound());
      answer(manager, 'users');
      const query = required(manager.submitClarification('save_failure'));
      const boundService = manager.specTools;
      const before = manager.currentSpec();
      expect(() => manager.beginTurn(query)).toThrow('模拟保存失败');
      expect(manager.currentSpec()).toEqual(before);
      expect(JSON.parse(boundService.getSpec())).toEqual(before);
      expect(manager.clarification.get().submissions).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
  it('已待批准的 Spec 在新提交后可继续澄清，完整保留最长自由回答', () => {
    const f = temporaryManager();
    try {
      f.manager.specTools.applySpecPatch(
        completePatch(f.manager.specTools) as Parameters<
          typeof f.manager.specTools.applySpecPatch
        >[0],
      );
      f.manager.specTools.applySpecPatch({
        expected_version: f.manager.currentSpec().version,
        change_reason: '准备审阅',
        operations: [{ op: 'set_spec_metadata', title: null, status: 'ready_for_approval' }],
      });
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users', '"'.repeat(1000));
      const query = required(f.manager.submitClarification('changed_answer'));
      f.manager.beginTurn(query);
      expect(f.manager.currentSpec().status).toBe('revised');
      expect(f.manager.currentSpec().evidence.at(-1)?.summary).toContain('"'.repeat(1000));
      f.manager.completeTurn();
    } finally {
      f.cleanup();
    }
  });
  it('首次回答关联了草稿实体的问题，不把草稿目标误标为已确认结论的复核', () => {
    const f = temporaryManager();
    try {
      f.manager.specTools.applySpecPatch({
        expected_version: 1,
        change_reason: '规划初始目标',
        operations: [{ op: 'put_goal', id: 'G-001', statement: '导出业务数据', evidence_ids: [] }],
      });
      const initial = initialRound();
      required(initial.questions[0]).spec_entity_ids = ['G-001'];
      f.manager.clarification.publish(initial);
      answer(f.manager, 'users');
      expect(f.manager.clarification.get().review_entity_ids).toEqual([]);
      expect(f.manager.clarification.get().questions[0]?.status).toBe('pending');
    } finally {
      f.cleanup();
    }
  });
  it('旧草稿被新答案取代后不会阻止显式重试', () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users', '旧草稿');
      answer(f.manager, 'users', '更正后的草稿');
      f.manager.submitClarification('submit_one');
      f.manager.beginTurn('处理答案');
      f.manager.interruptTurn();
      const retry = JSON.parse(f.manager.retryClarification());
      expect(retry.answers).toHaveLength(1);
      expect(retry.answers[0].answer.free_text).toBe('更正后的草稿');
    } finally {
      f.cleanup();
    }
  });
  it('不适用事项保留草稿历史，但不能再被提交或阻塞准备检查', () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'files');
      const patch = currentPatch(f.manager);
      patch.topics = patch.topics.map((t) => ({ ...t, needs_detail: false }));
      const files = patch.questions.find((q) => q.id === 'files');
      if (!files) throw new Error('缺少问题');
      files.status = 'inactive';
      files.change_reason = '当前需求不包含此分支';
      f.manager.clarification.publish(patch);
      expect(
        f.manager.clarification
          .validationIssues()
          .some((issue) => issue.entity_id === 'clarification_plan'),
      ).toBe(false);
      const submission = f.manager.submitClarification('note_only', '新的需求说明');
      if (!submission) throw new Error('缺少提交');
      expect(JSON.parse(submission).answers).toEqual([]);
      expect(f.manager.clarification.get().questions.find((q) => q.id === 'files')?.status).toBe(
        'inactive',
      );
    } finally {
      f.cleanup();
    }
  });
  it('问题选项变化后保留旧版本，历史回答仍指向原来展示的选项', () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      const patch = currentPatch(f.manager);
      const question = patch.questions[0];
      if (!question?.input) throw new Error('缺少问题');
      question.input = {
        ...question.input,
        options: question.input.options.map((o) => ({ ...o, label: '新的方向' })),
      };
      f.manager.clarification.publish(patch);
      const plan = f.manager.clarification.get();
      expect(
        plan.question_history.find((q) => q.id === 'users' && q.version === 1)?.input?.options[0]
          ?.label,
      ).toBe('管理员');
      expect(plan.questions[0]?.input?.options[0]?.label).toBe('新的方向');
    } finally {
      f.cleanup();
    }
  });
  it('版本、依赖环、无效引用与每轮上限被拒绝，失败不修改旧总览', () => {
    const f = temporaryManager();
    try {
      const initial = initialRound();
      const cycle = structuredClone(initial);
      required(cycle.questions[0]).depends_on = ['files'];
      required(cycle.questions[1]).depends_on = ['users'];
      expect(() => f.manager.clarification.publish(cycle)).toThrow();
      expect(f.manager.clarification.get().version).toBe(0);
      expect(() =>
        f.manager.clarification.publish({ ...initial, question_ids: ['missing'] }),
      ).toThrow();
      expect(() =>
        f.manager.clarification.publish({ ...initial, question_ids: Array(6).fill('users') }),
      ).toThrow();
      f.manager.clarification.publish(initial);
      expect(() => f.manager.clarification.publish(initial)).toThrow('版本冲突');
      const omitted = currentPatch(f.manager);
      omitted.questions.pop();
      expect(() => f.manager.clarification.publish(omitted)).toThrow('历史');
    } finally {
      f.cleanup();
    }
  });
  it('任意顺序、组合答案、立即持久化、部分提交与幂等；草稿不进入 Spec', () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'files');
      f.manager.deferClarification('users', true);
      expect(f.manager.currentSpec().evidence).toEqual([]);
      expect(
        new LocalSessionStore(f.root).load(f.manager.current.session_id).clarification_plan.answers,
      ).toHaveLength(1);
      const query = required(f.manager.submitClarification('submit_one'));
      expect(JSON.parse(query).answers[0].answer).toMatchObject({
        selected_option_id: 'recommended',
        free_text: '仅供管理员使用',
      });
      expect(f.manager.submitClarification('submit_one')).toBeNull();
      expect(() => f.manager.submitClarification('submit_two')).toThrow('先作答');
      expect(JSON.parse(f.manager.specTools.validateSpec()).ready_for_approval).toBe(false);
      const patch = currentPatch(f.manager);
      patch.question_ids = ['users'];
      expect(() => f.manager.clarification.publish(patch)).toThrow('可回答');
      f.manager.deferClarification('users', false);
      expect(f.manager.clarification.get().questions[0]?.status).toBe('pending');
    } finally {
      f.cleanup();
    }
  });
  it('答案绑定 Session、问题版本与选项；问题更新后旧草稿不能提交', () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      answer(f.manager, 'users');
      const valid = {
        session_id: f.manager.current.session_id,
        question_id: 'users',
        question_version: 1,
        answer: {
          request_id: 'users:1',
          selected_option_id: 'missing',
          free_text: null,
          source: 'user' as const,
        },
      };
      expect(() => f.manager.editClarification(valid)).toThrow('未展示');
      expect(() => f.manager.editClarification({ ...valid, session_id: 'other' })).toThrow(
        'Session',
      );
      const patch = currentPatch(f.manager);
      required(patch.questions[0]).statement = '改变问题范围';
      f.manager.clarification.publish(patch);
      expect(() => f.manager.submitClarification('submit_one')).toThrow('过期');
      expect(() => f.manager.editClarification(valid)).toThrow('改变');
    } finally {
      f.cleanup();
    }
  });
  it('解决问题必须引用提交证据；改答案后依赖与旧结论必须复核', () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(initialRound());
      const fake = currentPatch(f.manager);
      required(fake.questions[0]).status = 'resolved';
      expect(() => f.manager.clarification.publish(fake)).toThrow('证据');
      answer(f.manager, 'users');
      f.manager.submitClarification('submit_one');
      f.manager.beginTurn('处理提交');
      ground(f.manager, 'users');
      const patch = currentPatch(f.manager);
      required(patch.questions[0]).status = 'resolved';
      required(patch.questions[0]).spec_entity_ids = ['D-001'];
      required(patch.questions[1]).depends_on = ['users'];
      f.manager.clarification.publish(patch);
      f.manager.completeTurn();
      answer(f.manager, 'users', '所有用户都可以');
      expect(f.manager.clarification.get().questions[0]?.status).toBe('review_needed');
      expect(f.manager.clarification.get().review_entity_ids).toContain('D-001');
      expect(() =>
        f.manager.specTools.applySpecPatch({
          expected_version: f.manager.currentSpec().version,
          change_reason: '不能提前批准',
          operations: [{ op: 'set_spec_metadata', title: null, status: 'ready_for_approval' }],
        }),
      ).toThrow('澄清');
      expect(f.manager.clarification.get().answers).toHaveLength(2);
    } finally {
      f.cleanup();
    }
  });
  it('迁移 v1 备份只写一次，历史保持不变，新 Session 总览互相隔离', () => {
    const f = temporaryManager();
    try {
      const old = JSON.parse(
        readFileSync(new URL('./fixtures/python-session-v1.json', import.meta.url), 'utf8'),
      );
      const directory = join(f.root, '.specpilot/sessions', old.session_id);
      mkdirSync(directory, { recursive: true });
      const path = join(directory, 'session.json');
      const bytes = JSON.stringify(old);
      writeFileSync(path, bytes);
      const store = new LocalSessionStore(f.root);
      const migrated = store.load(old.session_id);
      expect(migrated.schema_version).toBe(2);
      expect(migrated.messages).toEqual(old.messages);
      store.save(migrated);
      store.save(migrated);
      expect(readFileSync(`${path}.v1.bak`, 'utf8')).toBe(bytes);
      f.manager.clarification.publish(initialRound());
      const original = f.manager.current.session_id;
      f.manager.create('独立会话');
      expect(f.manager.clarification.get().questions).toEqual([]);
      f.manager.switch(original);
      expect(f.manager.clarification.get().questions).toHaveLength(2);
    } finally {
      f.cleanup();
    }
  });
});

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import type { SessionManager } from '../src/runtime/session/manager.js';
import { temporaryManager } from './helpers.js';
import { answer, currentPatch, initialRound } from './round-helpers.js';

function ground(manager: SessionManager, id: string, decisionId = 'D-001') {
  const a = manager.clarification
    .get()
    .answers.filter((a) => a.question_id === id)
    .at(-1)!;
  const spec = manager.currentSpec();
  const evidence = spec.evidence.find((e) => e.locator === `clarification:${a.id}`)!;
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
  it('版本、依赖环、无效引用与每轮上限被拒绝，失败不修改旧总览', () => {
    const f = temporaryManager();
    try {
      const initial = initialRound();
      const cycle = structuredClone(initial);
      cycle.questions[0]!.depends_on = ['files'];
      cycle.questions[1]!.depends_on = ['users'];
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
      const query = f.manager.submitClarification('submit_one')!;
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
      patch.questions[0]!.statement = '改变问题范围';
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
      fake.questions[0]!.status = 'resolved';
      expect(() => f.manager.clarification.publish(fake)).toThrow('证据');
      answer(f.manager, 'users');
      f.manager.submitClarification('submit_one');
      f.manager.beginTurn('处理提交');
      ground(f.manager, 'users');
      const patch = currentPatch(f.manager);
      patch.questions[0]!.status = 'resolved';
      patch.questions[0]!.spec_entity_ids = ['D-001'];
      patch.questions[1]!.depends_on = ['users'];
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

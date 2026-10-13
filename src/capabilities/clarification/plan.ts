import { z } from 'zod';
import { newId, type Specification, utcNow } from '../spec/models.js';
import type { ClarificationAnswer } from './models.js';
import {
  type ClarificationPlan,
  type ClarificationQuestion,
  editAnswerSchema,
  emptyPlan,
  clarificationIdSchema as key,
  type PublishRound,
  planSchema,
  publishRoundSchema,
} from './plan-models.js';

export {
  type ClarificationPlan,
  type ClarificationQuestion,
  type ClarificationRound,
  type ClarificationTopic,
  editAnswerSchema,
  emptyPlan,
  type PublishRound,
  planSchema,
  publishRoundSchema,
} from './plan-models.js';

/** 领域端口由 Session 装配；界面操作写稳定快照，模型操作只在完整轮次结束后提交。 */
export class ClarificationPlanService {
  constructor(
    private readonly sessionId: string,
    private readonly read: () => ClarificationPlan,
    private readonly write: (plan: ClarificationPlan) => void,
    private readonly spec: () => Specification,
    private readonly published: () => void = () => undefined,
  ) {}
  get(): ClarificationPlan {
    return structuredClone(this.read());
  }
  private save(plan: ClarificationPlan): void {
    plan.version++;
    this.write(planSchema.parse(plan));
  }
  private question(plan: ClarificationPlan, id: string): ClarificationQuestion {
    const q = plan.questions.find((q) => q.id === id);
    if (!q) throw new Error('问题不存在');
    return q;
  }
  private entities(spec = this.spec()) {
    return [
      ...spec.goals,
      ...spec.scope,
      ...spec.requirements,
      ...spec.decisions,
      ...spec.assumptions,
      ...spec.open_questions,
      ...spec.acceptance_criteria,
    ];
  }
  private grounded(q: ClarificationQuestion, plan: ClarificationPlan): boolean {
    const spec = this.spec();
    const entities = this.entities(spec).filter((e) => q.spec_entity_ids.includes(e.id));
    if (!entities.length || entities.some((e) => e.lifecycle !== 'active')) return false;
    const latest = plan.answers.filter((a) => a.question_id === q.id).at(-1);
    if (latest && (!latest.submission_id || latest.question_version !== q.version)) return false;
    const evidence = spec.evidence.filter((e) =>
      entities.some((i) => i.evidence_ids.includes(e.id)),
    );
    return evidence.some((e) =>
      latest
        ? e.kind === 'clarification' && e.locator === `clarification:${latest.id}`
        : e.kind === 'repository',
    );
  }
  publish(input: PublishRound): string {
    const patch = publishRoundSchema.parse(input);
    const plan = this.get();
    if (plan.version !== patch.expected_version) throw new Error('澄清版本冲突');
    const entityIds = new Set(this.entities().map((e) => e.id));
    if (
      plan.topics.some((t) => !patch.topics.some((p) => p.id === t.id)) ||
      plan.questions.some((q) => !patch.questions.some((p) => p.id === q.id))
    )
      throw new Error('不能删除澄清历史；不再适用的问题应标记 inactive');
    plan.topics = patch.topics;
    plan.questions = patch.questions.map((incoming) => {
      const old = plan.questions.find((q) => q.id === incoming.id);
      if (
        incoming.spec_entity_ids.some((id) => !entityIds.has(id)) ||
        (incoming.open_question_id &&
          !this.spec().open_questions.some((q) => q.id === incoming.open_question_id))
      )
        throw new Error('问题 Spec 引用无效');
      const changed =
        !!old &&
        (JSON.stringify(old.input) !== JSON.stringify(incoming.input) ||
          old.statement !== incoming.statement ||
          JSON.stringify(old.depends_on) !== JSON.stringify(incoming.depends_on));
      const q: ClarificationQuestion = {
        ...incoming,
        version: old ? old.version + Number(changed) : 1,
      };
      if (incoming.status === 'resolved') {
        if (
          (old?.status !== 'resolved' ||
            changed ||
            JSON.stringify(old.spec_entity_ids) !== JSON.stringify(q.spec_entity_ids)) &&
          (changed || !this.grounded(q, plan))
        )
          throw new Error('解决问题必须关联有效回答或仓库证据');
        if (incoming.open_question_id) {
          const oq = this.spec().open_questions.find((o) => o.id === incoming.open_question_id);
          if (oq?.lifecycle === 'active' && oq.status !== 'resolved')
            throw new Error('关联 OpenQuestion 未解决');
        }
      } else if (incoming.status === 'pending' && old) {
        q.status = changed ? 'review_needed' : old.status === 'inactive' ? 'pending' : old.status;
      }
      if (
        incoming.status === 'inactive' &&
        incoming.open_question_id &&
        this.spec().open_questions.some(
          (oq) =>
            oq.id === incoming.open_question_id &&
            oq.lifecycle === 'active' &&
            oq.status === 'open',
        )
      )
        throw new Error('不适用问题必须停用关联的 OpenQuestion');
      return q;
    });
    // 模型只能安排已成熟且依赖已解决的问题；暂缓事项需用户显式恢复或有效依赖变化。
    for (const id of patch.question_ids) {
      const q = this.question(plan, id);
      if (
        q.status === 'deferred' &&
        q.depends_on.some(
          (dep) =>
            this.question(plan, dep).status === 'resolved' &&
            this.read().questions.find((p) => p.id === dep)?.status !== 'resolved',
        )
      )
        q.status = 'pending';
      if (
        !q.input ||
        !['pending', 'review_needed', 'submitted'].includes(q.status) ||
        q.depends_on.some(
          (dep) => !['resolved', 'inactive'].includes(this.question(plan, dep).status),
        )
      )
        throw new Error('本轮只能包含可回答且依赖已解决的问题');
    }
    plan.review_entity_ids = plan.review_entity_ids.filter((id) => {
      const entity = this.entities().find((e) => e.id === id);
      if (!entity || entity.lifecycle === 'retired') return false;
      const latestEvidence = plan.answers
        .filter((a) => a.submission_id)
        .map((a) => `clarification:${a.id}`);
      const refreshed = this.spec().evidence.some(
        (e) =>
          entity.evidence_ids.includes(e.id) &&
          latestEvidence.includes(e.locator) &&
          plan.questions.some(
            (q) =>
              q.status === 'resolved' &&
              q.spec_entity_ids.includes(id) &&
              plan.answers.filter((a) => a.question_id === q.id).at(-1)?.id ===
                e.locator.slice('clarification:'.length),
          ),
      );
      const superseded = this.spec().decisions.some(
        (d) =>
          d.lifecycle === 'active' &&
          d.supersedes_id === id &&
          plan.questions.some(
            (q) =>
              q.status === 'resolved' && q.spec_entity_ids.includes(d.id) && this.grounded(q, plan),
          ),
      );
      return !refreshed && !superseded;
    });
    for (const s of plan.submissions) if (s.status !== 'processed') s.status = 'processed';
    plan.rounds.push({
      id: newId('ROUND'),
      question_ids: patch.question_ids,
      summary: patch.summary,
    });
    this.save(plan);
    this.published();
    return JSON.stringify({
      status: 'clarification_round_ready',
      version: plan.version,
      round: plan.rounds.at(-1),
    });
  }
  edit(input: z.infer<typeof editAnswerSchema>): void {
    const edit = editAnswerSchema.parse(input);
    if (edit.session_id !== this.sessionId) throw new Error('答案属于其他 Session');
    const plan = this.get();
    const q = this.question(plan, edit.question_id);
    if (
      !q.input ||
      q.status === 'inactive' ||
      q.version !== edit.question_version ||
      edit.answer.request_id !== `${q.id}:${q.version}`
    )
      throw new Error('问题已改变，请重新作答');
    if (
      edit.answer.selected_option_id &&
      !q.input.options.some((o) => o.id === edit.answer.selected_option_id)
    )
      throw new Error('未展示的选项');
    if (edit.answer.free_text && !q.input.allow_custom_answer)
      throw new Error('当前问题不允许自由输入');
    const old = plan.answers.filter((a) => a.question_id === q.id).at(-1);
    if (old && JSON.stringify(old.answer) === JSON.stringify(edit.answer)) return;
    plan.answers.push({
      id: newId('ANSWER'),
      question_id: q.id,
      question_version: q.version,
      answer: edit.answer,
      created_at: utcNow(),
      submission_id: null,
    });
    const affected = new Set([q.id]);
    let size = 0;
    while (size !== affected.size) {
      size = affected.size;
      for (const candidate of plan.questions)
        if (candidate.depends_on.some((id) => affected.has(id))) affected.add(candidate.id);
    }
    for (const candidate of plan.questions)
      if (affected.has(candidate.id)) {
        if (
          candidate.id !== q.id ||
          candidate.status === 'resolved' ||
          candidate.spec_entity_ids.length
        ) {
          candidate.status = 'review_needed';
          plan.review_entity_ids.push(...candidate.spec_entity_ids);
        } else if (candidate.id === q.id) candidate.status = 'pending';
      }
    plan.review_entity_ids = [...new Set(plan.review_entity_ids)];
    this.save(plan);
  }
  defer(id: string, deferred: boolean): void {
    const plan = this.get();
    const q = this.question(plan, id);
    if (['resolved', 'inactive', 'submitted'].includes(q.status)) throw new Error('该问题不能暂缓');
    q.status = deferred ? 'deferred' : q.spec_entity_ids.length ? 'review_needed' : 'pending';
    this.save(plan);
  }
  submit(id: string, note = ''): string | null {
    const plan = this.get();
    note = note || plan.draft_note;
    key.parse(id);
    z.string().max(2000).parse(note);
    if (plan.submissions.some((s) => s.id === id)) return null;
    const answers = plan.questions.flatMap((q) => {
      const latest = plan.answers.filter((a) => a.question_id === q.id).at(-1);
      return latest && !latest.submission_id && q.status !== 'deferred' ? [latest] : [];
    });
    for (const old of plan.submissions) if (old.status !== 'processed') old.status = 'processed';
    if (!answers.length && !note.trim()) throw new Error('请先作答、补充说明或结束澄清');
    for (const a of answers) {
      if (a.question_version !== this.question(plan, a.question_id).version)
        throw new Error('答案版本已过期，请重新作答');
      a.submission_id = id;
      this.question(plan, a.question_id).status = 'submitted';
    }
    plan.submissions.push({ id, answer_ids: answers.map((a) => a.id), note, status: 'pending' });
    plan.draft_note = '';
    this.save(plan);
    return this.submissionMessage(id);
  }
  submissionMessage(id: string): string {
    const plan = this.get();
    const submission = plan.submissions.find((s) => s.id === id);
    if (!submission) throw new Error('提交不存在');
    return JSON.stringify({
      type: 'clarification_submission',
      session_id: this.sessionId,
      submission,
      answers: plan.answers
        .filter((a) => submission.answer_ids.includes(a.id))
        .map((a) => ({
          ...a,
          question: this.question(plan, a.question_id).statement,
          evidence_locator: `clarification:${a.id}`,
        })),
    });
  }
  markRetry(): void {
    const plan = this.get();
    for (const s of plan.submissions) if (s.status === 'pending') s.status = 'retry';
    this.write(planSchema.parse(plan));
  }
  setNote(note: string): void {
    const plan = this.get();
    plan.draft_note = z.string().max(2000).parse(note);
    this.save(plan);
  }
  retry(): string {
    const plan = this.get();
    const submission = plan.submissions.findLast(
      (s) => s.status === 'retry' || s.status === 'pending',
    );
    if (!submission) throw new Error('没有待重试的提交');
    if (plan.answers.some((a) => !a.submission_id))
      throw new Error('存在新的答案草稿，请提交更正后继续');
    submission.status = 'pending';
    this.save(plan);
    return this.submissionMessage(submission.id);
  }
  validationIssues() {
    const plan = this.get();
    const issues = plan.questions
      .filter(
        (q) =>
          q.status === 'submitted' ||
          q.status === 'review_needed' ||
          (q.blocking && !['resolved', 'inactive'].includes(q.status)),
      )
      .map((q) => ({
        code: 'clarification_pending',
        severity: 'error' as const,
        message: '澄清问题尚未解决或需要复核。',
        entity_id: q.id,
      }));
    if (
      plan.answers.some(
        (a) =>
          !a.submission_id &&
          plan.answers.filter((b) => b.question_id === a.question_id).at(-1)?.id === a.id,
      ) ||
      plan.submissions.some((s) => s.status !== 'processed') ||
      plan.review_entity_ids.length ||
      plan.topics.some((t) => t.needs_detail) ||
      plan.draft_note.trim()
    )
      issues.push({
        code: 'clarification_pending',
        severity: 'error',
        message: '存在未提交、未处理或待细化的澄清事项。',
        entity_id: 'clarification_plan',
      });
    return issues;
  }
}

/** 将旧 Spec 问题投影到总览；保留业务 ID 与决策关系，成熟问题由下一轮补充选项。 */
export function planFromSpec(spec: Specification): ClarificationPlan {
  const plan = emptyPlan();
  const questions = spec.open_questions.filter((q) => q.lifecycle === 'active');
  if (!questions.length) return plan;
  plan.topics.push({
    id: 'legacy',
    title: '已有需求事项',
    needs_detail: questions.some((q) => q.status === 'open'),
  });
  plan.questions = questions.map((q) => ({
    id: q.id,
    topic_id: 'legacy',
    statement: q.statement,
    blocking: q.blocking,
    depends_on: [],
    input: null,
    version: 1,
    open_question_id: q.id,
    spec_entity_ids: q.resolution_decision_id ? [q.resolution_decision_id] : [],
    status: q.status === 'resolved' ? 'resolved' : 'pending',
    change_reason: '从 v1 Session 导入',
  }));
  return planSchema.parse(plan);
}

export function questionRequest(q: ClarificationQuestion) {
  if (!q.input) throw new Error('该主题需要先由 Agent 细化');
  return { ...q.input, request_id: `${q.id}:${q.version}` };
}
export function latestAnswer(plan: ClarificationPlan, id: string): ClarificationAnswer | undefined {
  return plan.answers.filter((a) => a.question_id === id).at(-1)?.answer;
}
export function topicStatus(plan: ClarificationPlan, id: string): string {
  const topic = plan.topics.find((t) => t.id === id);
  const qs = plan.questions.filter((q) => q.topic_id === id);
  if (topic?.needs_detail) return 'needs_detail';
  if (qs.some((q) => q.status === 'review_needed')) return 'review_needed';
  if (qs.some((q) => q.status === 'submitted')) return 'submitted';
  if (qs.some((q) => q.status === 'pending')) return 'pending';
  if (qs.some((q) => q.status === 'deferred')) return 'deferred';
  return qs.length && qs.every((q) => q.status === 'inactive') ? 'inactive' : 'resolved';
}

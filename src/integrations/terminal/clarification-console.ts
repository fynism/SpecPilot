import type { ClarificationPresenter } from '../../capabilities/clarification/models.js';
import {
  latestAnswer,
  questionRequest,
  topicStatus,
} from '../../capabilities/clarification/plan.js';
import { isClarificationStopRequest } from '../../capabilities/clarification/policy.js';
import { ClarificationCancelled } from '../../capabilities/clarification/tool.js';
import { newId } from '../../capabilities/spec/models.js';
import type { SessionManager } from '../../runtime/session/manager.js';
import { type TextKey, translate } from './i18n.js';

/** 文本菜单与 TUI 使用同一领域服务；模型只在继续、重试或结束时运行。 */
export async function runClarificationConsole(
  manager: SessionManager,
  read: () => Promise<string | null>,
  emit: (text: string) => void,
  presenter: ClarificationPresenter,
  run: (query: string) => Promise<void>,
): Promise<void> {
  let all = false;
  while (true) {
    const plan = manager.clarification.get();
    const note = plan.draft_note;
    const round = plan.rounds.at(-1);
    const questions = all
      ? plan.questions
      : plan.questions.filter((q) => round?.question_ids.includes(q.id));
    emit(`澄清总览 · ${all ? '全部主题' : '本轮问题'} · v${plan.version}`);
    emit(
      `当前已识别 ${plan.questions.length} 个事项，已解决 ${plan.questions.filter((q) => q.status === 'resolved').length} 个`,
    );
    if (round) emit(round.summary);
    if (all)
      for (const topic of plan.topics)
        emit(
          `${topic.title} · ${translate('zh-CN', `board.status.${topicStatus(plan, topic.id)}` as TextKey)}`,
        );
    for (const [i, q] of questions.entries()) {
      const answer = latestAnswer(plan, q.id);
      emit(
        `${i + 1}. ${q.statement} · ${translate('zh-CN', `board.status.${q.status}` as TextKey)}${q.blocking ? ' · 阻塞' : ''}`,
      );
      if (answer) emit(`当前回答：${answer.selected_option_id ?? ''} ${answer.free_text ?? ''}`);
      if (q.depends_on.length) emit(`依赖：${q.depends_on.join(', ')}`);
    }
    if (note) emit(`补充说明：${note}`);
    emit(
      '编号编辑 · a 本轮/全部 · d <编号> 暂缓/恢复 · h <编号> 历史 · n 补充 · c 继续 · r 重试 · x 结束澄清 · b 返回对话',
    );
    const raw = await read();
    if (raw === null || ['b', 'q', ''].includes(raw.trim().toLowerCase())) return;
    const value = raw.trim();
    try {
      if (isClarificationStopRequest(value)) {
        await run('/done');
        return;
      }
      if (value === 'a') {
        all = !all;
        continue;
      }
      if (value === 'n') {
        emit('请输入补充说明：');
        const value = (await read()) ?? '';
        if (isClarificationStopRequest(value)) {
          await run('/done');
          return;
        }
        manager.setClarificationNote(value);
        continue;
      }
      if (value === 'x' || value === '/done') {
        await run('/done');
        return;
      }
      if (value === 'r') {
        await run(manager.retryClarification());
        continue;
      }
      if (value === 'c') {
        const query = manager.submitClarification(newId('SUBMIT'), note);
        if (query) await run(query);
        continue;
      }
      const match = /^(?:(d|h)\s+)?(\d+)$/.exec(value);
      const q = match ? questions[Number(match[2]) - 1] : undefined;
      if (!q) {
        emit('请选择有效编号或操作。');
        continue;
      }
      if (match?.[1] === 'd') {
        manager.deferClarification(q.id, q.status !== 'deferred');
        continue;
      }
      if (match?.[1] === 'h') {
        for (const a of plan.answers.filter((a) => a.question_id === q.id))
          emit(
            `${a.created_at} · ${a.submission_id ? '已提交' : '草稿'} · ${a.answer.selected_option_id ?? ''} ${a.answer.free_text ?? ''}`,
          );
        continue;
      }
      if (!q.input || q.status === 'inactive') {
        emit('该事项待细化或已不适用。');
        continue;
      }
      const answer = await presenter.ask(questionRequest(q));
      if (answer.free_text && isClarificationStopRequest(answer.free_text)) {
        await run('/done');
        return;
      }
      manager.editClarification({
        session_id: manager.current.session_id,
        question_id: q.id,
        question_version: q.version,
        answer,
      });
    } catch (error) {
      if (!(error instanceof ClarificationCancelled))
        emit(error instanceof Error ? error.message : '操作失败');
    }
  }
}

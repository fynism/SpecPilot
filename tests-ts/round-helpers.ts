import type { PublishRound } from '../src/capabilities/clarification/plan.js';
import { questionRequest } from '../src/capabilities/clarification/plan.js';
import type { SessionManager } from '../src/runtime/session/manager.js';
import { clarification, required } from './helpers.js';

export const initialRound = (): PublishRound => ({
  expected_version: 0,
  topics: [
    { id: 'scope', title: '目标与范围', needs_detail: false },
    { id: 'storage', title: '存储规则', needs_detail: true },
  ],
  questions: ['users', 'files'].map((id) => ({
    id,
    topic_id: 'scope',
    input: clarification,
    statement: id === 'users' ? '谁可以导出？' : '需要哪些文件？',
    blocking: true,
    depends_on: [],
    open_question_id: null,
    spec_entity_ids: [],
    status: 'pending',
    change_reason: '基础需求优先',
  })),
  question_ids: ['users', 'files'],
  summary: '先确认使用场景，存储规则稍后细化',
});
export function currentPatch(manager: SessionManager): PublishRound {
  const plan = manager.clarification.get();
  return {
    expected_version: plan.version,
    topics: plan.topics,
    questions: plan.questions.map(({ version: _version, ...q }) => ({
      ...q,
      status: q.status === 'resolved' || q.status === 'inactive' ? q.status : 'pending',
    })),
    question_ids: [],
    summary: '更新需求地图',
  };
}
export function answer(manager: SessionManager, id: string, freeText = '仅供管理员使用'): void {
  const q = required(manager.clarification.get().questions.find((q) => q.id === id));
  manager.editClarification({
    session_id: manager.current.session_id,
    question_id: id,
    question_version: q.version,
    answer: {
      request_id: questionRequest(q).request_id,
      selected_option_id: 'recommended',
      free_text: freeText,
      source: 'user',
    },
  });
}

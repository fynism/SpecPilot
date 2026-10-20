import { isClarificationStopRequest } from '../capabilities/clarification/policy.js';
import type { AgentRuntime, StopReason } from './agent.js';
import type { SessionManager } from './session/manager.js';

/** 手动压缩是轮次间操作，不把斜杠命令变成用户请求或改变中断状态。 */
export async function compactSession(
  manager: SessionManager,
  runtime: AgentRuntime,
): Promise<boolean> {
  if (manager.current.status === 'running') throw new Error('Agent 运行中不能手动压缩上下文');
  manager.beginUsageTurn();
  return runtime.compact(manager.messages);
}

/** 两个前端共用稳定轮次边界，异常必须回到可恢复起点。 */
export async function runSessionTurn(
  manager: SessionManager,
  runtime: AgentRuntime,
  query: string,
  source: 'chat' | 'clarification' = 'chat',
): Promise<StopReason | 'stop'> {
  if (runtime.hooks.trigger('UserPromptSubmit', manager.messages, query) === 'stop') return 'stop';
  const stopped = isClarificationStopRequest(query);
  const entry = source === 'chat' ? /^\/clarify\s+([\s\S]+)$/i.exec(query.trim()) : null;
  // 来源由宿主传入，不能解析用户粘贴的 submission JSON 来授予写权限。
  manager.beginTurn(query, source === 'clarification' && !stopped);
  try {
    if (entry) {
      const assessment = await runtime.assessClarification({
        request: entry[1] ?? '',
        current_spec: manager.currentSpec(),
        clarification_plan: manager.clarification.get(),
      });
      if (assessment.kind !== 'ready') {
        manager.messages.push({ role: 'assistant', content: assessment.message });
        await runtime.refreshForChat(manager.messages);
        manager.completeTurn();
        return 'model_complete';
      }
      manager.admitClarification();
    }
    const reason = await runtime.run(manager.messages, !stopped, source === 'chat' && !entry);
    if (reason === 'clarification_round_ready') {
      const plan = manager.clarification.get();
      const round = plan.rounds.at(-1);
      if (round && !round.question_ids.length) {
        const validation = manager.specTools.validation();
        const ready =
          manager.currentSpec().status === 'ready_for_approval' && validation.ready_for_approval;
        // 发布工具已结束模型循环；由宿主呈现可核验结果，不增加第二套完成判定。
        manager.messages.push({
          role: 'assistant',
          content: `${round.summary}\n${ready ? '需求已具备审阅条件，请检查当前 Spec。' : `尚未完成：${validation.issues.map((i) => i.message).join('；')}`}\n可用 /clarify 查看进度；普通聊天不会修改需求。`,
        });
        await runtime.refreshForChat(manager.messages);
        manager.completeTurn();
        return ready ? 'clarification_completed' : 'clarification_incomplete';
      }
    }
    manager.completeTurn();
    return reason;
  } catch (error) {
    manager.interruptTurn();
    throw error;
  }
}

import { isClarificationStopRequest } from '../capabilities/clarification/policy.js';
import type { AgentRuntime, StopReason } from './agent.js';
import type { SessionManager } from './session/manager.js';

/** 手动压缩是轮次间操作，不把斜杠命令变成用户请求或改变中断状态。 */
export async function compactSession(
  manager: SessionManager,
  runtime: AgentRuntime,
): Promise<boolean> {
  if (manager.current.status === 'running') throw new Error('Agent 运行中不能手动压缩上下文');
  return runtime.compact(manager.messages);
}

/** 两个前端共用稳定轮次边界，异常必须回到可恢复起点。 */
export async function runSessionTurn(
  manager: SessionManager,
  runtime: AgentRuntime,
  query: string,
): Promise<StopReason | 'stop'> {
  if (runtime.hooks.trigger('UserPromptSubmit', manager.messages, query) === 'stop') return 'stop';
  manager.beginTurn(query);
  try {
    const reason = await runtime.run(manager.messages, !isClarificationStopRequest(query));
    manager.completeTurn();
    return reason;
  } catch (error) {
    manager.interruptTurn();
    throw error;
  }
}

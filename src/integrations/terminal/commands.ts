import type { SessionManager } from '../../runtime/session/manager.js';
import { tokenConsumptionText } from './text.js';

export const commands = [
  '/new',
  '/sessions',
  '/switch',
  '/rename',
  '/status',
  '/clarify',
  '/compact',
  '/done',
  '/language',
  '/quit',
] as const;
export type CommandResult = 'not_command' | 'handled' | 'session_changed' | 'quit' | 'compact';
export function statusText(manager: SessionManager): string {
  const session = manager.current;
  const spec = manager.currentSpec();
  const ledger = session.token_usage;
  return `当前 Session：${session.session_id} · ${session.title} · ${session.status}\n当前 Spec：${spec.spec_id} · v${spec.version} · ${spec.status}\n${tokenConsumptionText(ledger, 'zh-CN')}\n本次已统计输入 ${ledger.current_turn.input_tokens} / 输出 ${ledger.current_turn.output_tokens}；累计已统计输入 ${ledger.total.input_tokens} / 输出 ${ledger.total.output_tokens}`;
}
/** 只处理轮次间命令；没有参数的选择交互由前端提供。 */
export function handleSessionCommand(
  query: string,
  manager: SessionManager,
  emit: (text: string) => void,
): CommandResult {
  const [name, ...parts] = query.trim().split(/\s+/);
  const command = name?.toLowerCase();
  const argument = parts.join(' ');
  if (!command?.startsWith('/') || command === '/done') return 'not_command';
  if (manager.current.status === 'running') {
    emit('Agent 运行中不能执行 Session 命令。');
    return 'handled';
  }
  if (command === '/quit') return 'quit';
  if (command === '/compact') {
    if (argument) {
      emit('用法：/compact');
      return 'handled';
    }
    return 'compact';
  }
  if (command === '/new') {
    const session = manager.create(argument || '新对话');
    emit(`已创建并切换到 Session：${session.session_id} · ${session.title}`);
    return 'session_changed';
  }
  if (command === '/sessions') {
    for (const session of manager.listSessions())
      emit(
        `${session.session_id === manager.current.session_id ? '*' : ' '} ${session.session_id} · ${session.title} · ${session.status}`,
      );
    return 'handled';
  }
  if (command === '/switch') {
    if (!argument) {
      emit('用法：/switch <session-id>');
      return 'handled';
    }
    try {
      const session = manager.switch(argument);
      emit(`已切换到 Session：${session.session_id} · ${session.title}`);
      if (session.status === 'interrupted')
        emit('该 Session 的上一轮未完整结束，系统不会自动重放模型或工具调用。');
      return 'session_changed';
    } catch (error) {
      emit(`无法切换 Session：${error instanceof Error ? error.name : 'UnknownError'}`);
      return 'handled';
    }
  }
  if (command === '/rename') {
    if (!argument) {
      emit('用法：/rename <标题>');
      return 'handled';
    }
    const session = manager.rename(argument);
    emit(`Session 已重命名为：${session.title}`);
    return 'handled';
  }
  if (command === '/status') {
    emit(statusText(manager));
    return 'handled';
  }
  emit(`未知命令：${command}`);
  return 'handled';
}

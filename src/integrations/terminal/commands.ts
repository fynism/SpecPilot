import type { SessionManager } from '../../runtime/session/manager.js';

export const commands = [
  '/new',
  '/sessions',
  '/switch',
  '/rename',
  '/status',
  '/done',
  '/language',
  '/quit',
] as const;
export type CommandResult = 'not_command' | 'handled' | 'session_changed' | 'quit';
export function statusText(manager: SessionManager): string {
  const session = manager.current;
  const spec = manager.currentSpec();
  return `当前 Session：${session.session_id} · ${session.title} · ${session.status}\n当前 Spec：${spec.spec_id} · v${spec.version} · ${spec.status}`;
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

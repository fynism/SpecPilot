import type { EventName, HookDispatcher } from '../tooling/contracts.js';

type Hook = (...args: unknown[]) => unknown;
const events: EventName[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'ClarificationRequested',
  'ClarificationAnswered',
  'ClarificationCancelled',
];

/** 顺序固定且首个非空结果短路；安全 Hook 抛错时不会继续执行工具。 */
export class HookRegistry {
  private readonly callbacks = new Map<EventName, Hook[]>(events.map((event) => [event, []]));
  register(event: EventName, hook: Hook): void {
    const callbacks = this.callbacks.get(event);
    if (!callbacks) throw new Error(`未知 Hook 事件：${event}`);
    callbacks.push(hook);
  }
  readonly trigger: HookDispatcher = (event, ...args) => {
    const callbacks = this.callbacks.get(event);
    if (!callbacks) throw new Error(`未知 Hook 事件：${event}`);
    for (const hook of callbacks) {
      const result = hook(...args);
      if (result !== undefined && result !== null) return result;
    }
    return undefined;
  };
}
export function buildDefaultHooks(root: string, emit: (text: string) => void): HookRegistry {
  const hooks = new HookRegistry();
  hooks.register('UserPromptSubmit', () => {
    emit(`工作目录：${root}`);
  });
  hooks.register('Stop', () => {
    emit('本轮结束。');
  });
  return hooks;
}

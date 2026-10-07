import type { ClarificationPresenter } from './capabilities/clarification/models.js';
import { ClarificationStopController } from './capabilities/clarification/policy.js';
import type { Settings } from './config.js';
import { AnthropicModelClient } from './integrations/anthropic/model.js';
import { AgentRuntime } from './runtime/agent.js';
import { buildDefaultHooks } from './runtime/hooks.js';
import type { ModelClient } from './runtime/model.js';
import type { SessionManager } from './runtime/session/manager.js';
import { buildDefaultRegistry } from './tooling/catalog.js';
import { ToolExecutor } from './tooling/executor.js';

/** 单一组合根供 Ink 与逐行前端共用，每次切换 Session 创建隔离运行时。 */
export function buildSessionRuntime(
  manager: SessionManager,
  root: string,
  settings: Settings,
  presenter: ClarificationPresenter,
  emit: (text: string) => void,
  client?: ModelClient,
): AgentRuntime {
  const hooks = buildDefaultHooks(root, emit);
  const stop = new ClarificationStopController();
  hooks.register('ClarificationAnswered', (_request, answer) => {
    stop.observeAnswer(answer);
  });
  const registry = buildDefaultRegistry(root, manager.specTools, presenter, hooks.trigger);
  return new AgentRuntime(
    client ?? new AnthropicModelClient(settings),
    hooks,
    registry,
    new ToolExecutor(registry, hooks.trigger),
    stop,
    settings.max_tool_use_turns,
    emit,
  );
}

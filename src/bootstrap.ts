import type { ClarificationPresenter } from './capabilities/clarification/models.js';
import { ClarificationStopController } from './capabilities/clarification/policy.js';
import type { Settings } from './config.js';
import { AnthropicModelClient } from './integrations/anthropic/model.js';
import { AgentRuntime } from './runtime/agent.js';
import {
  buildContextMessages,
  ContextManager,
  estimateContextUsage,
} from './runtime/context/index.js';
import { buildDefaultHooks } from './runtime/hooks.js';
import type { ModelClient } from './runtime/model.js';
import { SYSTEM } from './runtime/prompts.js';
import type { SessionManager } from './runtime/session/manager.js';
import { buildDefaultRegistry } from './tooling/catalog.js';
import { ToolExecutor } from './tooling/executor.js';

/** 只读取上下文与工具声明，供前端在等待、运行和切换 Session 时显示统一用量。 */
export function buildContextUsageReader(manager: SessionManager, root: string) {
  const registry = buildDefaultRegistry(
    root,
    manager.specTools,
    {
      ask: async () => {
        throw new Error('用量读取器不能执行澄清');
      },
    },
    () => undefined,
  );
  const tools = registry.toolSpecs();
  return () =>
    estimateContextUsage(
      buildContextMessages(manager.messages, manager.context, manager.currentSpec()),
      tools,
      SYSTEM,
    );
}

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
  const model = client ?? new AnthropicModelClient(settings);
  return new AgentRuntime(
    model,
    hooks,
    registry,
    new ToolExecutor(registry, hooks.trigger),
    stop,
    settings.max_tool_use_turns,
    emit,
    new ContextManager(
      model,
      {
        read: () => manager.context,
        write: (state) => manager.updateContext(state),
        spec: () => manager.currentSpec(),
      },
      emit,
      settings.model,
    ),
  );
}

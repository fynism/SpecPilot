import type { ClarificationPresenter } from './capabilities/clarification/models.js';
import { ClarificationStopController } from './capabilities/clarification/policy.js';
import type { Settings } from './config.js';
import { AnthropicModelClient } from './integrations/anthropic/model.js';
import { AgentRuntime } from './runtime/agent.js';
import {
  buildContextMessages,
  ContextManager,
  contextRequestKey,
  estimateContextUsage,
} from './runtime/context/index.js';
import { buildDefaultHooks } from './runtime/hooks.js';
import type { ModelClient } from './runtime/model.js';
import { ROUND_SYSTEM, SYSTEM } from './runtime/prompts.js';
import type { SessionManager } from './runtime/session/manager.js';
import { MeteredModelClient } from './runtime/usage.js';
import { buildDefaultRegistry } from './tooling/catalog.js';
import { ToolExecutor } from './tooling/executor.js';

/** 只读取上下文与工具声明，供前端在等待、运行和切换 Session 时显示统一用量。 */
export function buildContextUsageReader(
  manager: SessionManager,
  root: string,
  clarificationMode: 'rounds' | 'single' = 'rounds',
) {
  const registry = buildDefaultRegistry(
    root,
    manager.specTools,
    {
      ask: async () => {
        throw new Error('用量读取器不能执行澄清');
      },
    },
    () => undefined,
    clarificationMode === 'rounds' ? manager.clarificationService() : undefined,
  );
  const tools = registry.toolSpecs();
  const system = clarificationMode === 'rounds' ? ROUND_SYSTEM : SYSTEM;
  return () => {
    const messages = buildContextMessages(manager.messages, manager.context, manager.currentSpec());
    const measurement = manager.contextMeasurement;
    if (measurement?.key === contextRequestKey(messages, tools, system)) return measurement.usage;
    const estimate = estimateContextUsage(messages, tools, system);
    return {
      ...estimate,
      source:
        measurement?.usage.source === 'estimate' ? ('estimate' as const) : ('pending' as const),
    };
  };
}

/** 单一组合根供 Ink 与逐行前端共用，每次切换 Session 创建隔离运行时。 */
export function buildSessionRuntime(
  manager: SessionManager,
  root: string,
  settings: Settings,
  presenter: ClarificationPresenter,
  emit: (text: string) => void,
  client?: ModelClient,
  clarificationMode: 'rounds' | 'single' = 'rounds',
): AgentRuntime {
  const hooks = buildDefaultHooks(root, emit);
  const stop = new ClarificationStopController();
  hooks.register('ClarificationAnswered', (_request, answer) => {
    stop.observeAnswer(answer);
  });
  let ready = false;
  const plan =
    clarificationMode === 'rounds'
      ? manager.clarificationService(() => {
          ready = true;
        })
      : undefined;
  const registry = buildDefaultRegistry(root, manager.specTools, presenter, hooks.trigger, plan);
  const model = new MeteredModelClient(client ?? new AnthropicModelClient(settings), (usage) => {
    manager.recordTokenUsage(usage);
    emit(usage ? '模型实际 Token 消耗已更新。' : '供应商未返回本次调用用量，实际消耗统计不完整。');
  });
  return new AgentRuntime(
    model,
    hooks,
    registry,
    new ToolExecutor(registry, hooks.trigger),
    stop,
    settings.max_tool_use_turns,
    emit,
    () => ready,
    clarificationMode === 'rounds' ? ROUND_SYSTEM : undefined,
    new ContextManager(
      model,
      {
        read: () => manager.context,
        write: (state) => manager.updateContext(state),
        spec: () => manager.currentSpec(),
        measured: (measurement) => manager.measureContext(measurement),
      },
      emit,
      settings.model,
    ),
  );
}

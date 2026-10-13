import type { ClarificationStopController } from '../capabilities/clarification/policy.js';
import type { ToolExecutor } from '../tooling/executor.js';
import type { ToolRegistry } from '../tooling/registry.js';
import { ContextManager, contextStateSchema, RESPONSE_TOKENS } from './context/index.js';
import type { HookRegistry } from './hooks.js';
import {
  ContextLimitError,
  type Message,
  type ModelBlock,
  type ModelClient,
  modelBlockSchema,
} from './model.js';
import { FINAL_RESPONSE_SYSTEM_SUFFIX, SYSTEM } from './prompts.js';

export type StopReason = 'model_complete' | 'max_tool_use_turns';

/** 模型选择路径，确定性代码约束输入、工具执行、预算与终止。 */
export class AgentRuntime {
  private readonly context: ContextManager;
  constructor(
    private readonly client: ModelClient,
    readonly hooks: HookRegistry,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly stop: ClarificationStopController,
    private readonly maxToolUseTurns: number,
    private readonly emit: (text: string) => void,
    context?: ContextManager,
  ) {
    if (!Number.isInteger(maxToolUseTurns) || maxToolUseTurns < 1)
      throw new Error('工具轮次上限必须为正整数');
    let state = contextStateSchema.parse({});
    this.context =
      context ??
      new ContextManager(
        client,
        {
          read: () => state,
          write: (next) => {
            state = next;
          },
          spec: () => null,
        },
        emit,
      );
  }
  async compact(messages: Message[]): Promise<boolean> {
    return this.context.compact(messages, this.registry.toolSpecs(), SYSTEM);
  }
  async run(messages: Message[], toolsEnabled = true): Promise<StopReason> {
    toolsEnabled = toolsEnabled && !this.stop.consumeRequest();
    let toolTurns = 0;
    while (true) {
      const tools = toolsEnabled ? this.registry.toolSpecs() : [];
      const system = toolsEnabled ? SYSTEM : SYSTEM + FINAL_RESPONSE_SYSTEM_SUFFIX;
      const input = await this.context.prepare(messages, tools, system);
      let blocks: ModelBlock[];
      try {
        blocks = await this.client.createMessage(input, tools, system, RESPONSE_TOKENS);
      } catch (error) {
        if (!(error instanceof ContextLimitError)) throw error;
        // 供应商窗口可能小于暂定值；仅重试一次，不重放已执行工具。
        await this.context.compact(messages, tools, system, 'provider_limit');
        blocks = await this.client.createMessage(
          await this.context.prepare(messages, tools, system),
          tools,
          system,
          RESPONSE_TOKENS,
        );
      }
      const response = blocks.map((block) => modelBlockSchema.parse(block));
      messages.push({ role: 'assistant', content: response });
      this.emit('模型响应已接收。');
      const calls = response.filter((block) => block.type === 'tool_use');
      if (!calls.length) {
        const force = this.hooks.trigger('Stop', messages);
        if (typeof force === 'string' && force) {
          messages.push({ role: 'user', content: force });
          continue;
        }
        await this.context.refresh(messages, this.registry.toolSpecs(), SYSTEM);
        return 'model_complete';
      }
      const results: Exclude<Message['content'], string> = [];
      for (const call of calls) {
        let output = 'Error: 用户已结束澄清，本轮禁止调用工具；请直接总结已有上下文。';
        // 即便供应商异常返回 tool_use，也在执行器之前确定性拒绝；同批余下调用同样受约束。
        if (toolsEnabled && !this.stop.requested) {
          this.emit(`执行工具：${call.name}`);
          output = await this.executor.execute(call.name, call.input);
          this.emit(`工具完成：${call.name} · ${Array.from(output).length} 字符`);
        }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
      }
      messages.push({ role: 'user', content: results });
      this.emit('工具结果已加入上下文。');
      const stopRequested = this.stop.consumeRequest();
      if (stopRequested) toolsEnabled = false;
      toolTurns++;
      // 同批并行调用算一轮，先保留全部配对结果再暂停；结束回答优先进入最后总结。
      if (toolTurns >= this.maxToolUseTurns && !stopRequested) {
        await this.context.refresh(messages, this.registry.toolSpecs(), SYSTEM);
        return 'max_tool_use_turns';
      }
    }
  }
}

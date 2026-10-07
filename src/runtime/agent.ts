import type { ClarificationStopController } from '../capabilities/clarification/policy.js';
import type { ToolExecutor } from '../tooling/executor.js';
import type { ToolRegistry } from '../tooling/registry.js';
import type { HookRegistry } from './hooks.js';
import { type Message, type ModelClient, modelBlockSchema } from './model.js';
import { FINAL_RESPONSE_SYSTEM_SUFFIX, SYSTEM } from './prompts.js';

export type StopReason = 'model_complete' | 'max_tool_use_turns';

/** 模型选择路径，确定性代码约束输入、工具执行、预算与终止。 */
export class AgentRuntime {
  constructor(
    private readonly client: ModelClient,
    readonly hooks: HookRegistry,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly stop: ClarificationStopController,
    private readonly maxToolUseTurns: number,
    private readonly emit: (text: string) => void,
  ) {
    if (!Number.isInteger(maxToolUseTurns) || maxToolUseTurns < 1)
      throw new Error('工具轮次上限必须为正整数');
  }
  async run(messages: Message[], toolsEnabled = true): Promise<StopReason> {
    toolsEnabled = toolsEnabled && !this.stop.consumeRequest();
    let toolTurns = 0;
    while (true) {
      const response = (
        await this.client.createMessage(
          messages,
          toolsEnabled ? this.registry.toolSpecs() : [],
          toolsEnabled ? SYSTEM : SYSTEM + FINAL_RESPONSE_SYSTEM_SUFFIX,
          8000,
        )
      ).map((block) => modelBlockSchema.parse(block));
      messages.push({ role: 'assistant', content: response });
      const calls = response.filter((block) => block.type === 'tool_use');
      if (!calls.length) {
        const force = this.hooks.trigger('Stop', messages);
        if (typeof force === 'string' && force) {
          messages.push({ role: 'user', content: force });
          continue;
        }
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
      const stopRequested = this.stop.consumeRequest();
      if (stopRequested) toolsEnabled = false;
      toolTurns++;
      // 同批并行调用算一轮，先保留全部配对结果再暂停；结束回答优先进入最后总结。
      if (toolTurns >= this.maxToolUseTurns && !stopRequested) return 'max_tool_use_turns';
    }
  }
}

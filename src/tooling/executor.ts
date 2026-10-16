import type { HookDispatcher, ToolCall } from './contracts.js';
import type { ToolRegistry } from './registry.js';

/** 所有调用先校验，再经 Policy Hook，最后执行并发布结果事件。 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly trigger: HookDispatcher,
  ) {}
  async execute(name: string, input: unknown, readOnly = false): Promise<string> {
    let tool: ReturnType<ToolRegistry['get']>;
    try {
      tool = this.registry.get(name);
    } catch {
      return 'Error: 未知工具';
    }
    const parsed = tool.spec.inputSchema.safeParse(input);
    if (!parsed.success)
      return `Error: 工具 ${name} 参数无效：${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('；')}`;
    // 模型即便返回未公开的写调用，也不能扩大本轮只读权限。
    if (readOnly && !tool.readOnly)
      return 'Error: 普通对话只允许读取；请使用 /clarify <需求描述>。';
    const call: ToolCall = { name, input: parsed.data };
    const blocked = this.trigger('PreToolUse', call);
    if (blocked !== undefined && blocked !== null) return String(blocked);
    let output: string;
    try {
      output = String(await tool.handler(parsed.data));
    } catch (error) {
      // 外部错误文本可能含密钥；模型只收到分类，不复制异常原文。
      output = `Error: 工具 ${name} 执行失败（${error instanceof Error ? error.name : 'UnknownError'}）`;
    }
    this.trigger('PostToolUse', call, output);
    return output;
  }
}

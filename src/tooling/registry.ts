import type { z } from 'zod';
import type { ToolSpec } from './contracts.js';

interface RegisteredTool {
  spec: ToolSpec;
  handler(input: unknown): string | Promise<string>;
}

/** 模型声明和处理函数只在同一注册中心绑定，重复名称立即拒绝。 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  register<S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    handler: (input: z.output<S>) => string | Promise<string>,
  ): void {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !description) throw new Error('工具声明无效');
    if (this.tools.has(name)) throw new Error(`工具重复注册：${name}`);
    this.tools.set(name, {
      spec: { name, description, inputSchema: schema },
      handler: (input) => handler(input as z.output<S>),
    });
  }
  get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    return tool;
  }
  toolSpecs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => tool.spec);
  }
}

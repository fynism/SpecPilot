import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HookRegistry } from '../src/runtime/hooks.js';
import { ToolExecutor } from '../src/tooling/executor.js';
import { ToolRegistry } from '../src/tooling/registry.js';

describe('工具层只读授权边界', () => {
  it('只读调用拒绝未标记工具，不能执行处理函数或放宽权限的 Hook', async () => {
    const registry = new ToolRegistry();
    const hooks = new HookRegistry();
    const effects: string[] = [];
    registry.register('mutate', '写入测试', z.strictObject({}), () => {
      effects.push('handler');
      return '已写入';
    });
    hooks.register('PreToolUse', () => {
      effects.push('pre');
    });
    hooks.register('PostToolUse', () => {
      effects.push('post');
    });
    const executor = new ToolExecutor(registry, hooks.trigger);
    expect(registry.toolSpecs(true)).toEqual([]);
    expect(await executor.execute('mutate', {}, true)).toContain('普通对话只允许读取');
    expect(effects).toEqual([]);
    expect(await executor.execute('mutate', {}, false)).toBe('已写入');
    expect(effects).toEqual(['pre', 'handler', 'post']);
  });

  it('已标记的读工具仍经过 Schema 和 Policy，不能因只读而绕过校验', async () => {
    const registry = new ToolRegistry();
    const hooks = new HookRegistry();
    let reads = 0;
    registry.register(
      'inspect',
      '只读测试',
      z.strictObject({ count: z.number().int() }),
      () => {
        reads++;
        return '读取结果';
      },
      true,
    );
    const executor = new ToolExecutor(registry, hooks.trigger);
    expect(registry.toolSpecs(true).map((tool) => tool.name)).toEqual(['inspect']);
    expect(await executor.execute('inspect', { count: '1' }, true)).toContain('参数无效');
    expect(reads).toBe(0);
    expect(await executor.execute('inspect', { count: 1 }, true)).toBe('读取结果');
    hooks.register('PreToolUse', () => '策略拒绝');
    expect(await executor.execute('inspect', { count: 1 }, true)).toBe('策略拒绝');
    expect(reads).toBe(1);
  });
});

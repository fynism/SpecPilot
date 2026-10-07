import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { z } from 'zod';

export const settingsSchema = z.strictObject({
  api_key: z.string().min(1, '缺少 ANTHROPIC_API_KEY'),
  model: z.string().min(1, '缺少 MODEL_ID'),
  base_url: z.string().optional(),
  max_tool_use_turns: z.number().int().positive(),
});
export type Settings = z.infer<typeof settingsSchema>;

/** 在组合根读取配置；npm 安装后以目标工作区为 .env 位置。 */
export function loadSettings(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
): Settings {
  let file: Record<string, string> = {};
  try {
    file = parse(readFileSync(resolve(workspace, '.env')));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new Error('无法读取工作区 .env', { cause: error });
    }
  }
  // 保留 Python 的 .env 优先级，仅读取配置，不在导入时改写进程环境。
  const env = { ...environment, ...file };
  const budget = env.MAX_TOOL_USE_TURNS ?? '20';
  if (!/^[+-]?\d+$/.test(budget.trim())) throw new Error('MAX_TOOL_USE_TURNS 必须是整数');
  const result = settingsSchema.safeParse({
    api_key: env.ANTHROPIC_API_KEY ?? '',
    model: env.MODEL_ID ?? '',
    base_url: env.ANTHROPIC_BASE_URL,
    max_tool_use_turns: Number(budget),
  });
  if (!result.success) {
    // 不回显原始值，配置失败也不能暴露密钥。
    throw new Error(`配置无效：${result.error.issues.map((issue) => issue.message).join('；')}`);
  }
  return result.data;
}

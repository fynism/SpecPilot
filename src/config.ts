import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { z } from 'zod';

export const protocolSchema = z.enum(['anthropic', 'openai']);
export type ApiProtocol = z.infer<typeof protocolSchema>;
const nonempty = z.string().trim().min(1);
export const baseUrlSchema = nonempty.refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\s\p{Cc}]/u.test(value)
    );
  } catch {
    return false;
  }
}, 'Base URL 必须是 HTTPS 地址，且不能包含账号、查询参数或片段');
export const userConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  protocol: protocolSchema,
  base_url: baseUrlSchema,
  model: nonempty.refine((value) => !/\p{Cc}/u.test(value)),
  api_key: nonempty.refine((value) => !/\p{Cc}/u.test(value)),
});
export type UserConfig = z.infer<typeof userConfigSchema>;
export type ConfigDraft = Partial<Omit<UserConfig, 'schema_version'>>;

export const settingsSchema = z.strictObject({
  protocol: protocolSchema.default('anthropic'),
  api_key: z.string().trim().min(1, '缺少 ANTHROPIC_API_KEY 或用户配置 API Key'),
  model: z.string().trim().min(1, '缺少 MODEL_ID 或用户配置模型 ID'),
  base_url: z.string().optional(),
  max_tool_use_turns: z.number().int().positive(),
});
// 允许旧的组合根调用方省略协议；配置读取边界始终补为 Anthropic。
export type Settings = z.input<typeof settingsSchema>;

/** 可以直接展示的配置错误；不拼接文件内容或底层异常。 */
export class ConfigurationError extends Error {
  override name = 'ConfigurationError';
}
export class MissingConfigurationError extends ConfigurationError {
  override name = 'MissingConfigurationError';
}

/** 用户配置独立于工作区，测试必须显式传入临时路径。 */
export function userConfigPath(): string {
  return join(homedir(), '.specpilot', 'config.json');
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 缺文件返回空；损坏、版本不兼容及读取失败均停止，不自动覆盖。 */
export function readUserConfig(path = userConfigPath()): UserConfig | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw new ConfigurationError('无法读取用户配置文件', { cause: error });
  }
  try {
    return userConfigSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new ConfigurationError('用户配置损坏或版本不兼容，请修复配置文件后重试', {
      cause: error,
    });
  }
}

function rejectSymlink(path: string): void {
  try {
    if (fs.lstatSync(path).isSymbolicLink())
      throw new ConfigurationError('配置目录或文件不能是符号链接');
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function restrictAccess(path: string, directory: boolean): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(path, directory ? 0o700 : 0o600);
    return;
  }
  // Windows 的 mode 不隔离用户；禁用继承并显式授予当前登录 SID 访问权限。
  // 不输出命令结果，身份查询失败时拒绝落盘，不能降级为宽权限保存密钥。
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot))
    throw new ConfigurationError('无法定位 Windows 系统权限工具');
  // 不通过 PATH 搜索，避免 Git/MSYS 的同名 whoami 或其他程序覆盖系统工具。
  const systemDirectory = join(systemRoot, 'System32');
  const identity = execFileSync(
    join(systemDirectory, 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
    },
  );
  const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new ConfigurationError('无法确认当前用户的配置访问权限');
  execFileSync(
    join(systemDirectory, 'icacls.exe'),
    [path, '/inheritance:r', '/grant:r', `*${sid}:${directory ? '(OI)(CI)' : ''}F`],
    {
      stdio: 'pipe',
      windowsHide: true,
    },
  );
}

/** 校验后原子保存；临时文件权限与正式配置一致，失败保留旧文件。 */
export function writeUserConfig(input: UserConfig, path = userConfigPath()): void {
  const result = userConfigSchema.safeParse(input);
  if (!result.success) throw new ConfigurationError('配置无效，拒绝保存');
  const directory = dirname(path);
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  let created = false;
  try {
    rejectSymlink(directory);
    rejectSymlink(path);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    restrictAccess(directory, true);
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try {
      // 已有目录可能保留显式宽权限，必须在写入密钥前独立收紧新文件的 ACL。
      restrictAccess(temporary, false);
      fs.writeFileSync(descriptor, `${JSON.stringify(result.data, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, path);
    created = false;
  } catch (error) {
    if (created) {
      try {
        fs.unlinkSync(temporary);
      } catch (cleanupError) {
        throw new ConfigurationError('配置保存失败，临时文件清理失败，请检查用户配置目录', {
          cause: new AggregateError([error, cleanupError]),
        });
      }
    }
    throw new ConfigurationError('无法安全保存用户配置，原配置未替换', { cause: error });
  }
}

export type Configuration = {
  path: string;
  source: 'workspace' | 'environment' | 'user' | 'none';
  draft: ConfigDraft;
  user?: UserConfig;
  budget: string;
  overrides: string[];
};

/** 只读取配置来源和草稿，不创建目录、Session 或网络客户端。 */
export function inspectConfiguration(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
  path = userConfigPath(),
): Configuration {
  let file: Record<string, string> = {};
  try {
    file = parse(fs.readFileSync(resolve(workspace, '.env')));
  } catch (error) {
    if (!missing(error)) throw new ConfigurationError('无法读取工作区 .env', { cause: error });
  }
  const user = readUserConfig(path);
  const env = { ...environment, ...file };
  const legacy = env.ANTHROPIC_API_KEY !== undefined || env.ANTHROPIC_BASE_URL !== undefined;
  const source = legacy
    ? file.ANTHROPIC_API_KEY !== undefined || file.ANTHROPIC_BASE_URL !== undefined
      ? 'workspace'
      : 'environment'
    : user
      ? 'user'
      : 'none';
  // 旧连接按一组选取，不能把用户文件的密钥补到旧 URL 上；模型可独立覆盖。
  const draft: ConfigDraft = legacy
    ? {
        protocol: 'anthropic',
        api_key: env.ANTHROPIC_API_KEY,
        base_url: env.ANTHROPIC_BASE_URL,
        model: env.MODEL_ID,
      }
    : {
        protocol: user?.protocol,
        api_key: user?.api_key,
        base_url: user?.base_url,
        model: env.MODEL_ID ?? user?.model,
      };
  const overrides = [];
  if (legacy && user) overrides.push('旧 .env 或进程环境连接配置优先生效，用户连接配置被覆盖。');
  if (user && env.MODEL_ID !== undefined) overrides.push('MODEL_ID 覆盖用户配置中的模型 ID。');
  return { path, source, draft, user, budget: env.MAX_TOOL_USE_TURNS ?? '20', overrides };
}

/** 严格解析有效运行设置，缺失和损坏分开处理，只有缺失允许进入向导。 */
export function resolveSettings(configuration: Configuration): z.output<typeof settingsSchema> {
  const { draft, budget } = configuration;
  if (!/^[+-]?\d+$/.test(budget.trim()))
    throw new ConfigurationError('MAX_TOOL_USE_TURNS 必须是整数');
  if (Number(budget) <= 0) throw new ConfigurationError('MAX_TOOL_USE_TURNS 必须是正整数');
  if (!draft.api_key?.trim() || !draft.model?.trim())
    throw new MissingConfigurationError(
      `配置缺失：${[
        !draft.api_key?.trim() ? '缺少 ANTHROPIC_API_KEY 或用户配置 API Key' : '',
        !draft.model?.trim() ? '缺少 MODEL_ID 或用户配置模型 ID' : '',
      ]
        .filter(Boolean)
        .join('；')}`,
    );
  const result = settingsSchema.safeParse({
    protocol: draft.protocol,
    api_key: draft.api_key,
    model: draft.model,
    base_url: draft.base_url,
    max_tool_use_turns: Number(budget),
  });
  if (!result.success) throw new ConfigurationError('配置无效，请检查配置字段');
  return result.data;
}

/** 保留原读取入口，npm 安装位置不作为工作区或用户配置根目录。 */
export function loadSettings(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
  path = userConfigPath(),
): z.output<typeof settingsSchema> {
  return resolveSettings(inspectConfiguration(workspace, environment, path));
}

/** 配置保存与运行能力分离，未接入的协议不得回落到其他供应商。 */
export function assertRunnableSettings(settings: Settings): void {
  if (settings.protocol === 'openai')
    throw new ConfigurationError('OpenAI 配置已保存，当前版本尚不支持运行此协议。');
}

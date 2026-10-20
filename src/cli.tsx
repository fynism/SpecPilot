#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { buildContextUsageReader, buildSessionRuntime } from './bootstrap.js';
import {
  assertRunnableSettings,
  ConfigurationError,
  inspectConfiguration,
  MissingConfigurationError,
  resolveSettings,
} from './config.js';
import { LocalSessionStore } from './integrations/filesystem/session-store.js';
import { type RuntimeFactory, TerminalApp } from './integrations/terminal/app.js';
import {
  configurationSourceText,
  runConfigurationWizard,
} from './integrations/terminal/configuration.js';
import { runConsole } from './integrations/terminal/console.js';
import { safeTerminalText } from './integrations/terminal/text.js';
import { SessionManager } from './runtime/session/manager.js';

const help = `SpecPilot · 需求澄清 Agent

用法：specpilot [config | --help | --version]
config                配置第三方 API，保存后退出
首次交互启动缺少配置时自动引导：协议 → Base URL → 模型 ID → API Key。
用户配置保存在 ~/.specpilot/config.json，Key 以明文保存并限制文件访问。
Anthropic 可运行；OpenAI 仅支持保存，暂不支持运行。不自动发送连接验证请求。
Esc / Ctrl+C 取消不保存；非交互环境缺少配置或执行 config 时直接报错。

兼容读取工作区 .env / 进程环境中的 ANTHROPIC_API_KEY、MODEL_ID、
ANTHROPIC_BASE_URL 和 MAX_TOOL_USE_TURNS；.env 优于同名进程变量。
存在旧 Key 或 URL 字段时整组使用旧连接，否则读取用户配置。
MODEL_ID 可独立覆盖用户模型；MAX_TOOL_USE_TURNS 默认为 20。

/new [标题]           创建并切换 Session
/sessions             列出本 worktree 的 Session
/switch [session-id]   选择或直接切换 Session
/rename <标题>        重命名当前 Session
/status               显示 Session 和 Spec 状态
/clarify [需求描述]   带描述开始梳理需求；无参数查看已有进度
/compact              手动压缩当前上下文，保留原始历史
/done                 结束澄清，只总结已有信息
/language [zh-CN|en-US] 切换全屏界面语言
/quit                 退出

交互终端使用 Ink 全屏；管道与 CI 使用逐行控制台。
普通输入仅进行聊天与只读调查，不修改 Spec；通过澄清面板提交答案继续需求处理。
状态保存在 .specpilot/sessions-v5/；导出在 .specpilot/specs/。
`;

/** npm 可执行入口，配置命令、帮助与版本均不创建 Session。 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0] ?? '')) {
    process.stdout.write(help);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0] ?? '')) {
    process.stdout.write('0.1.0\n');
    return;
  }
  const configure = args.length === 1 && args[0] === 'config';
  if (args.length && !configure) {
    process.stderr.write('参数无效，请运行 specpilot --help。\n');
    process.exitCode = 1;
    return;
  }
  try {
    const root = realpathSync(process.cwd());
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
    if (configure && !interactive)
      throw new ConfigurationError('specpilot config 需要交互终端，请在终端中运行。');
    let configuration = inspectConfiguration(root);
    if (configure) {
      const saved = await runConfigurationWizard(configuration);
      if (!saved) {
        process.stdout.write('已取消配置，原配置未修改。\n');
        return;
      }
      process.stdout.write(`配置已保存：${safeTerminalText(configuration.path)}\n`);
      process.stdout.write(`${configurationSourceText(inspectConfiguration(root))}\n`);
      if (saved.protocol === 'openai')
        process.stdout.write('OpenAI 配置已保存，当前版本尚不支持运行此协议。\n');
      return;
    }
    let settings: ReturnType<typeof resolveSettings>;
    let reportedSource = false;
    try {
      settings = resolveSettings(configuration);
    } catch (error) {
      if (!(error instanceof MissingConfigurationError)) throw error;
      if (!interactive)
        throw new ConfigurationError(
          '配置缺失，请在交互终端运行 specpilot config，或通过 .env / 环境变量提供完整配置。',
        );
      process.stdout.write('尚未完成 API 配置，进入配置向导。\n');
      const saved = await runConfigurationWizard(configuration);
      if (!saved) {
        process.stdout.write('已取消配置，原配置未修改。\n');
        return;
      }
      process.stdout.write(`配置已保存：${safeTerminalText(configuration.path)}\n`);
      configuration = inspectConfiguration(root);
      process.stdout.write(`${configurationSourceText(configuration)}\n`);
      reportedSource = true;
      settings = resolveSettings(configuration);
    }
    assertRunnableSettings(settings);
    if (!reportedSource) process.stdout.write(`${configurationSourceText(configuration)}\n`);
    const manager = new SessionManager(new LocalSessionStore(root));
    manager.start();
    const runtimeFactory: RuntimeFactory = (presenter, emit) =>
      buildSessionRuntime(manager, root, settings, presenter, emit);
    const getUsage = buildContextUsageReader(manager, root);
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const app = render(
        <TerminalApp manager={manager} runtimeFactory={runtimeFactory} getUsage={getUsage} />,
        {
          alternateScreen: true,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await app.waitUntilExit();
    } else await runConsole(manager, runtimeFactory, process.stdin, process.stdout, getUsage);
  } catch (error) {
    // 配置错误已在读取边界脱敏，其余外部异常只显示类型，避免供应商请求数据泄漏。
    const message =
      error instanceof ConfigurationError
        ? error.message
        : error instanceof Error
          ? error.name
          : 'UnknownError';
    process.stderr.write(`无法启动 SpecPilot：${message}\n`);
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  await main();

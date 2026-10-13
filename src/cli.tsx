#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { buildContextUsageReader, buildSessionRuntime } from './bootstrap.js';
import { loadSettings } from './config.js';
import { LocalSessionStore } from './integrations/filesystem/session-store.js';
import { type RuntimeFactory, TerminalApp } from './integrations/terminal/app.js';
import { runConsole } from './integrations/terminal/console.js';
import { SessionManager } from './runtime/session/manager.js';

const help = `SpecPilot · 需求澄清 Agent

用法：specpilot [--help | --version]
在目标仓库启动，从工作区 .env 读取 ANTHROPIC_API_KEY、MODEL_ID、
ANTHROPIC_BASE_URL 和 MAX_TOOL_USE_TURNS。

/new [标题]           创建并切换 Session
/sessions             列出本 worktree 的 Session
/switch [session-id]   选择或直接切换 Session
/rename <标题>        重命名当前 Session
/status               显示 Session 和 Spec 状态
/compact              手动压缩当前上下文，保留原始历史
/done                 结束澄清，只总结已有信息
/language [zh-CN|en-US] 切换全屏界面语言
/quit                 退出

交互终端使用 Ink 全屏；管道与 CI 使用逐行控制台。
状态保存在 .specpilot/sessions/；导出在 .specpilot/specs/。
`;

/** npm 可执行入口，帮助与版本不要求配置凭据或创建 Session。 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0] ?? '')) {
    process.stdout.write(help);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0] ?? '')) {
    process.stdout.write('0.1.0\n');
    return;
  }
  if (args.length) {
    process.stderr.write('参数无效，请运行 specpilot --help。\n');
    process.exitCode = 1;
    return;
  }
  try {
    const root = realpathSync(process.cwd());
    const settings = loadSettings(root);
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
      error instanceof Error &&
      /^(配置无效|缺少|MAX_TOOL_USE_TURNS|无法读取工作区)/.test(error.message)
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

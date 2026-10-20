import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { render } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextUsageReader, buildSessionRuntime } from '../src/bootstrap.js';
import { main } from '../src/cli.js';
import {
  ConfigurationError,
  inspectConfiguration,
  type UserConfig,
  writeUserConfig,
} from '../src/config.js';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import type { ConfigurationWizard } from '../src/integrations/terminal/configuration.js';
import { runConfigurationWizard } from '../src/integrations/terminal/configuration.js';
import { runConsole } from '../src/integrations/terminal/console.js';

const location = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => location.home,
}));
vi.mock('ink', async (original) => ({
  ...(await original<typeof import('ink')>()),
  render: vi.fn(() => ({ waitUntilExit: async () => undefined })),
}));
vi.mock('../src/integrations/terminal/configuration.js', async (original) => ({
  ...(await original<typeof import('../src/integrations/terminal/configuration.js')>()),
  runConfigurationWizard: vi.fn(),
}));
vi.mock('../src/integrations/terminal/console.js', () => ({ runConsole: vi.fn() }));
vi.mock('../src/bootstrap.js', () => ({
  buildContextUsageReader: vi.fn(),
  buildSessionRuntime: vi.fn(),
}));

const existing: UserConfig = {
  schema_version: 1,
  protocol: 'anthropic',
  base_url: 'https://gateway.example/anthropic',
  model: 'custom-model',
  api_key: 'private-test-key',
};
let root: string;
let workspace: string;
let path: string;
let output: string;
let errors: string;
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const originalExitCode = process.exitCode;

function tty(enabled: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: enabled });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: enabled });
}
function saveThroughWizard(config = existing) {
  vi.mocked(runConfigurationWizard).mockImplementation(async (configuration) => {
    writeUserConfig(config, configuration.path);
    return config;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(join(tmpdir(), 'specpilot-startup-'));
  workspace = join(root, 'workspace');
  fs.mkdirSync(workspace);
  location.home = join(root, 'home');
  path = join(location.home, '.specpilot', 'config.json');
  output = '';
  errors = '';
  process.exitCode = undefined;
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MODEL_ID', 'MAX_TOOL_USE_TURNS'])
    vi.stubEnv(key, undefined);
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors += String(chunk);
    return true;
  });
  vi.mocked(runConfigurationWizard).mockResolvedValue(undefined);
  tty(true);
});

afterEach(() => {
  // 先恢复进程对象，确保测试框架正常输出且不会继承失败退出码。
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CLI 配置与首次启动', () => {
  it('向导宿主实际保存并销毁独立终端，返回配置结果', async () => {
    const actual = await vi.importActual<
      typeof import('../src/integrations/terminal/configuration.js')
    >('../src/integrations/terminal/configuration.js');
    const unmount = vi.fn();
    vi.mocked(render).mockImplementationOnce((element) => ({
      unmount,
      rerender: vi.fn(),
      waitUntilRenderFlush: async () => undefined,
      cleanup: vi.fn(),
      clear: vi.fn(),
      waitUntilExit: async () => {
        const wizard = element as ReactElement<Parameters<typeof ConfigurationWizard>[0]>;
        wizard.props.onSave(existing);
      },
    }));
    const saved = await actual.runConfigurationWizard(inspectConfiguration(workspace, {}, path));
    expect(saved).toEqual(existing);
    expect(unmount).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual(existing);
    expect(fs.existsSync(join(workspace, '.specpilot'))).toBe(false);
  });

  it('首次配置后继续启动，配置和 Session 不共享密钥', async () => {
    saveThroughWizard();
    await main([]);
    expect(runConfigurationWizard).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(buildContextUsageReader).toHaveBeenCalledOnce();
    expect(output).toContain('配置已保存');
    expect(output).toContain('用户配置文件');
    expect(errors).toBe('');
    expect(output).not.toContain(existing.api_key);
    expect(fs.readFileSync(path, 'utf8')).toContain(existing.api_key);
    const indexPath = join(workspace, '.specpilot', 'sessions-v5', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const session = fs.readFileSync(
      join(dirname(indexPath), index.active_session_id, 'session.json'),
      'utf8',
    );
    expect(session).not.toContain(existing.api_key);
  });

  it('已有配置跳过向导，非 TTY 使用 console 前端', async () => {
    writeUserConfig(existing, path);
    tty(false);
    await main([]);
    expect(runConfigurationWizard).not.toHaveBeenCalled();
    expect(runConsole).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('显式配置保存后退出，展示路径与旧配置覆盖来源', async () => {
    fs.writeFileSync(
      join(workspace, '.env'),
      'ANTHROPIC_API_KEY=legacy-secret\nMODEL_ID=old-model\n',
    );
    saveThroughWizard({ ...existing, protocol: 'openai' });
    await main(['config']);
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.existsSync(join(workspace, '.specpilot'))).toBe(false);
    expect(output).toContain(path);
    expect(output).toContain('工作区 .env');
    expect(output).toContain('用户连接配置被覆盖');
    expect(output).toContain('OpenAI 配置已保存，当前版本尚不支持运行此协议');
    expect(output).not.toContain('legacy-secret');
    expect(output).not.toContain(existing.api_key);
    expect(render).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([true, false])('取消配置不保存、不创建 Session，首次进入：%s', async (firstRun) => {
    if (!firstRun) writeUserConfig(existing, path);
    const before = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined;
    await main(firstRun ? [] : ['config']);
    expect(output).toContain('已取消配置');
    expect(fs.existsSync(join(workspace, '.specpilot'))).toBe(false);
    expect(render).not.toHaveBeenCalled();
    if (before) expect(fs.readFileSync(path, 'utf8')).toBe(before);
    else expect(fs.existsSync(path)).toBe(false);
  });

  it.each([true, false])('非交互缺配置或执行 config 直接失败，显式命令：%s', async (explicit) => {
    tty(false);
    await main(explicit ? ['config'] : []);
    expect(errors).toContain(explicit ? '需要交互终端' : '配置缺失');
    expect(process.exitCode).toBe(1);
    expect(runConfigurationWizard).not.toHaveBeenCalled();
    expect(fs.existsSync(location.home)).toBe(false);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it.each([
    true,
    false,
  ])('OpenAI 在创建 Session、客户端和前端前被拦截，首次配置：%s', async (firstRun) => {
    const config = { ...existing, protocol: 'openai' as const };
    if (firstRun) saveThroughWizard(config);
    else writeUserConfig(config, path);
    await main([]);
    expect(errors).toContain('当前版本尚不支持运行此协议');
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(join(workspace, '.specpilot'))).toBe(false);
    expect(buildSessionRuntime).not.toHaveBeenCalled();
    expect(buildContextUsageReader).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(runConsole).not.toHaveBeenCalled();
    expect(() => new AnthropicModelClient({ ...config, max_tool_use_turns: 20 })).toThrow(
      ConfigurationError,
    );
  });

  it.each([
    'broken',
    JSON.stringify({ ...existing, schema_version: 99 }),
  ])('损坏配置报错，不进入向导或重置文件', async (contents) => {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, contents);
    await main([]);
    expect(errors).toContain('用户配置损坏或版本不兼容');
    expect(errors).not.toContain(existing.api_key);
    expect(runConfigurationWizard).not.toHaveBeenCalled();
    expect(fs.readFileSync(path, 'utf8')).toBe(contents);
    expect(fs.existsSync(join(workspace, '.specpilot'))).toBe(false);
  });

  it('非法预算不触发配置向导', async () => {
    vi.stubEnv('MAX_TOOL_USE_TURNS', 'invalid');
    await main([]);
    expect(errors).toContain('MAX_TOOL_USE_TURNS 必须是整数');
    expect(runConfigurationWizard).not.toHaveBeenCalled();
  });

  it('旧连接不完整时不能通过新保存的用户 Key 静默补齐', async () => {
    fs.writeFileSync(
      join(workspace, '.env'),
      'ANTHROPIC_BASE_URL=https://old.example\nMODEL_ID=old\n',
    );
    saveThroughWizard();
    await main([]);
    expect(output).toContain('用户连接配置被覆盖');
    expect(errors).toContain('缺少 ANTHROPIC_API_KEY');
    expect(render).not.toHaveBeenCalled();
    expect(fs.existsSync(join(workspace, '.specpilot'))).toBe(false);
  });

  it('帮助、版本和无效参数不读取配置、不创建目录', async () => {
    await main(['--help']);
    expect(output).toContain('SpecPilot');
    await main(['--version']);
    expect(output).toContain('0.1.1');
    await main(['unknown']);
    expect(errors).toContain('参数无效');
    expect(fs.existsSync(location.home)).toBe(false);
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(runConfigurationWizard).not.toHaveBeenCalled();
  });
});

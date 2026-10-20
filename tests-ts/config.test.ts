import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseUrlSchema,
  ConfigurationError,
  inspectConfiguration,
  loadSettings,
  MissingConfigurationError,
  readUserConfig,
  type UserConfig,
  writeUserConfig,
} from '../src/config.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'specpilot-config-'));
  roots.push(root);
  return { root, path: join(root, '.specpilot', 'config.json') };
}
const config: UserConfig = {
  schema_version: 1,
  protocol: 'anthropic',
  base_url: 'https://gateway.example/anthropic',
  model: 'custom-model',
  api_key: 'test-private-key',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('用户配置持久化', () => {
  it.skipIf(process.platform !== 'win32').each(['whoami.exe', 'icacls.exe'])(
    'PATH 中的同名 %s 不影响安全保存配置',
    (command) => {
      const { root, path } = fixture();
      const shadow = join(root, 'shadow-bin');
      fs.mkdirSync(shadow);
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) throw new Error('Windows 回归测试需要 SystemRoot');
      const systemDirectory = join(systemRoot, 'System32');
      // 用不接受身份/ACL 参数的系统程序模拟 PATH 中的同名可执行文件。
      fs.copyFileSync(join(systemDirectory, 'where.exe'), join(shadow, command));
      vi.stubEnv('PATH', `${shadow}${delimiter}${process.env.PATH ?? ''}`);
      writeUserConfig(config, path);
      expect(readUserConfig(path)).toEqual(config);
      const acl = execFileSync(join(systemDirectory, 'icacls.exe'), [path], {
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(acl).not.toMatch(/BUILTIN\\Users|Everyone/);
    },
  );

  it('缺文件不写目录，保存带版本号的配置并限制访问权限', () => {
    const { root, path } = fixture();
    expect(readUserConfig(path)).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([]);
    writeUserConfig(config, path);
    expect(readUserConfig(path)).toEqual(config);
    expect(fs.readdirSync(dirname(path))).toEqual(['config.json']);
    if (process.platform === 'win32') {
      const acl = execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true });
      expect(acl).not.toMatch(/BUILTIN\\Users|Everyone/);
    } else {
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
  });

  it('原子替换失败时保留旧文件并清理包含密钥的临时文件', () => {
    const { path } = fixture();
    writeUserConfig(config, path);
    const before = fs.readFileSync(path, 'utf8');
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('simulated failure with test-private-key');
    });
    expect(() => writeUserConfig({ ...config, api_key: 'replacement' }, path)).toThrow(
      '原配置未替换',
    );
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(fs.readdirSync(dirname(path))).toEqual(['config.json']);
  });

  it.skipIf(process.platform !== 'win32')(
    '已有目录含宽泛显式 ACL 时，凭据文件仍只授权当前用户',
    () => {
      const { root, path } = fixture();
      fs.mkdirSync(dirname(path));
      execFileSync('icacls.exe', [dirname(path), '/grant', '*S-1-1-0:(OI)(CI)R'], {
        stdio: 'pipe',
        windowsHide: true,
      });
      writeUserConfig(config, path);
      const aclFile = join(root, 'acl.txt');
      execFileSync('icacls.exe', [path, '/save', aclFile], { stdio: 'pipe', windowsHide: true });
      expect(fs.readFileSync(aclFile, 'utf16le')).not.toContain(';;;WD');
    },
  );

  it.each([
    '{test-private-key',
    JSON.stringify({ ...config, schema_version: 2 }),
  ])('拒绝损坏及不兼容配置，不在错误中泄漏内容', (contents) => {
    const { root } = fixture();
    const path = join(root, 'config.json');
    fs.writeFileSync(path, contents);
    expect(() => readUserConfig(path)).toThrow('用户配置损坏或版本不兼容');
    try {
      readUserConfig(path);
    } catch (error) {
      expect(String(error)).not.toContain(config.api_key);
    }
    expect(fs.readFileSync(path, 'utf8')).toBe(contents);
  });

  it('读取失败不是配置缺失，非法输入不得写入', () => {
    const { root, path } = fixture();
    expect(() => readUserConfig(root)).toThrow(ConfigurationError);
    expect(() => readUserConfig(root)).not.toThrow(MissingConfigurationError);
    expect(() => writeUserConfig({ ...config, api_key: '   ' }, path)).toThrow('拒绝保存');
    expect(fs.existsSync(dirname(path))).toBe(false);
  });

  it.each([
    '',
    'http://gateway.example',
    'not-a-url',
    'https://user:secret@gateway.example',
    'https://gateway.example?key=secret',
    'https://gateway.example/#fragment',
    'https://gateway.example/\u001b[31m',
  ])('拒绝非法或含认证信息的 Base URL：%j', (url) => {
    expect(baseUrlSchema.safeParse(url).success).toBe(false);
  });

  it('保留合法的代理前缀和 /v1，不自动拼接或删除路径', () => {
    expect(baseUrlSchema.parse(' https://gateway.example/proxy/v1/ ')).toBe(
      'https://gateway.example/proxy/v1/',
    );
  });
});

describe('配置来源与兼容性', () => {
  it('没有旧连接时读取用户配置，独立覆盖模型和轮次预算', () => {
    const { root, path } = fixture();
    writeUserConfig({ ...config, protocol: 'openai' }, path);
    fs.writeFileSync(join(root, '.env'), 'MODEL_ID=workspace-model\n');
    const environment = { MODEL_ID: 'env-model', MAX_TOOL_USE_TURNS: '4' };
    expect(loadSettings(root, environment, path)).toEqual({
      protocol: 'openai',
      base_url: config.base_url,
      model: 'workspace-model',
      api_key: config.api_key,
      max_tool_use_turns: 4,
    });
    const inspected = inspectConfiguration(root, environment, path);
    expect(inspected.source).toBe('user');
    expect(inspected.overrides).toEqual(['MODEL_ID 覆盖用户配置中的模型 ID。']);
    expect(environment.MODEL_ID).toBe('env-model');
  });

  it('旧 .env 优于进程环境，整组选取旧连接并展示覆盖提示', () => {
    const { root, path } = fixture();
    writeUserConfig({ ...config, protocol: 'openai' }, path);
    fs.writeFileSync(
      join(root, '.env'),
      'ANTHROPIC_API_KEY=file-key\nMODEL_ID=file-model\nANTHROPIC_BASE_URL=https://old.example\n',
    );
    expect(loadSettings(root, { ANTHROPIC_API_KEY: 'env-key' }, path)).toEqual({
      protocol: 'anthropic',
      api_key: 'file-key',
      model: 'file-model',
      base_url: 'https://old.example',
      max_tool_use_turns: 20,
    });
    const inspected = inspectConfiguration(root, {}, path);
    expect(inspected.source).toBe('workspace');
    expect(inspected.overrides.join('')).toContain('用户连接配置被覆盖');
  });

  it('进程旧连接不继承用户 URL，缺少 Key 时不补用用户 Key', () => {
    const { root, path } = fixture();
    writeUserConfig(config, path);
    const env = { ANTHROPIC_API_KEY: 'legacy', MODEL_ID: 'legacy-model' };
    expect(loadSettings(root, env, path).base_url).toBeUndefined();
    expect(inspectConfiguration(root, env, path).source).toBe('environment');
    expect(() =>
      loadSettings(root, { ANTHROPIC_BASE_URL: 'https://old.example', MODEL_ID: 'm' }, path),
    ).toThrow(MissingConfigurationError);
  });

  it('缺失与错误区分，损坏用户配置不因存在旧配置而被吞掉', () => {
    const { root, path } = fixture();
    expect(() => loadSettings(root, {}, path)).toThrow(MissingConfigurationError);
    expect(() => loadSettings(root, { MAX_TOOL_USE_TURNS: '2.5' }, path)).toThrow('必须是整数');
    expect(() => loadSettings(root, { MAX_TOOL_USE_TURNS: '0' }, path)).toThrow('必须是正整数');
    fs.mkdirSync(dirname(path));
    fs.writeFileSync(path, 'broken');
    expect(() =>
      loadSettings(root, { ANTHROPIC_API_KEY: 'legacy', MODEL_ID: 'model' }, path),
    ).toThrow('用户配置损坏');
  });
});

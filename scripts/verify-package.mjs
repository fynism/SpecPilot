import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// 分发验收只在系统临时目录安装本地 tarball；不写全局包、不发布、不需要真实凭据。
const project = resolve('.');
const npmCli = process.env.npm_execpath;
assert(npmCli, '请通过 npm run smoke:package 调用');
const root = mkdtempSync(join(realpathSync(tmpdir()), 'specpilot-package-'));
const npm = (args, options = {}) =>
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd: project,
    encoding: 'utf8',
    ...options,
  });
try {
  npm(['run', 'build'], { stdio: 'inherit' });
  const [manifest] = JSON.parse(npm(['pack', '--dry-run', '--ignore-scripts', '--json']));
  assert(manifest.files.some((file) => file.path === 'dist/cli.js'));
  assert(manifest.files.some((file) => file.path === '.env.example'));
  assert(
    manifest.files.every(
      (file) =>
        !file.path.endsWith('.py') &&
        file.path !== '.env' &&
        !file.path.startsWith('tests') &&
        !file.path.startsWith('.specpilot/'),
    ),
  );
  npm(['pack', '--pack-destination', root, '--silent'], { stdio: 'inherit' });
  const tarball = join(root, manifest.filename);
  assert(existsSync(tarball));
  const installation = join(root, 'installation');
  mkdirSync(installation);
  // npm 会向父目录寻找项目根；显式创建清单并限定 prefix，避免临时安装落到上级项目。
  writeFileSync(
    join(installation, 'package.json'),
    JSON.stringify({ name: 'specpilot-package-verification', private: true }),
  );
  npm(
    [
      'install',
      tarball,
      '--prefix',
      installation,
      '--offline',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: installation,
      stdio: 'inherit',
    },
  );
  const executable = join(
    installation,
    'node_modules/.bin',
    process.platform === 'win32' ? 'specpilot.cmd' : 'specpilot',
  );
  assert(existsSync(executable), 'npm 应创建 CLI shim');
  const invoke = (args, input = '') =>
    npm(['exec', '--prefix', installation, '--offline', '--', 'specpilot', ...args], {
      cwd: installation,
      input,
    });
  const help = invoke(['--help']);
  assert(help.includes('/done'));
  assert(help.includes('/compact'));
  assert.equal(invoke(['--version']), '0.1.0\n');
  writeFileSync(
    join(installation, '.env'),
    'ANTHROPIC_API_KEY=offline\nMODEL_ID=fake\nMAX_TOOL_USE_TURNS=20\n',
  );
  const output = invoke([], '/new 分发验收\n/rename npm会话\n/status\n/compact\n/quit\n');
  assert(output.includes('npm会话'));
  assert(output.includes('/ 500,000 tokens'));
  assert(output.includes('没有可压缩的完整历史'));
  assert(!output.includes('\u001b'), '管道模式不得输出控制序列');
  const index = JSON.parse(
    readFileSync(join(installation, '.specpilot/sessions/index.json'), 'utf8'),
  );
  assert.equal(index.session_ids.length, 2);
  const session = JSON.parse(
    readFileSync(
      join(installation, `.specpilot/sessions/${index.active_session_id}/session.json`),
      'utf8',
    ),
  );
  assert.equal(session.title, 'npm会话');
  assert.equal(session.schema_version, 4);
  assert.equal(session.clarification_plan.version, 0);
  assert.deepEqual(session.context, { summary: '', through: 0, compactions: [] });
  assert.equal(session.token_usage.total.requests, 0);
  console.log('npm 分发验收通过：本地 tarball、仅生产依赖、CLI shim、帮助/版本、管道 Session。');
} finally {
  // 删除前复验绝对目标确为本脚本新建的临时目录，不接受任意环境输入作为删除对象。
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert(basename(root).startsWith('specpilot-package-'));
  rmSync(root, { recursive: true, force: true });
}

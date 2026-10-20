import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContextUsageReader } from '../src/bootstrap.js';
import type { ClarificationAnswer } from '../src/capabilities/clarification/models.js';
import { TerminalApp } from '../src/integrations/terminal/app.js';
import { catalogs } from '../src/integrations/terminal/catalogs.js';
import { commands, handleSessionCommand } from '../src/integrations/terminal/commands.js';
import { runConsole } from '../src/integrations/terminal/console.js';
import { resolveLocale } from '../src/integrations/terminal/i18n.js';
import { ClarificationOverlay, SessionOverlay } from '../src/integrations/terminal/overlays.js';
import { readableTranscript, safeTerminalText } from '../src/integrations/terminal/text.js';
import {
  buildLegacySessionRuntime as buildSessionRuntime,
  call,
  clarification,
  readyIntake,
  ScriptedClient,
  temporaryManager,
} from './helpers.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
type Screen = ReturnType<typeof render>;
async function frame(screen: Screen, text: string): Promise<void> {
  await vi.waitFor(() => expect(screen.lastFrame()).toContain(text));
  // Ink 写出帧早于 useInput 的被动 effect；等待下一事件循环再发送按键。
  await new Promise<void>((resolve) => setImmediate(resolve));
}
async function type(screen: Screen, value: string): Promise<void> {
  screen.stdin.write(value);
  await frame(screen, value);
}
const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };

describe('Ink 澄清真实按键', () => {
  it('回改已有组合答案保留选项与补充文字，取消不改写原答案', async () => {
    const answers: ClarificationAnswer[] = [];
    const original: ClarificationAnswer = {
      request_id: 'Q-existing',
      selected_option_id: 'expanded',
      free_text: '只支持 CSV',
      source: 'user',
    };
    const screen = render(
      <ClarificationOverlay
        locale="zh-CN"
        request={{ ...clarification, request_id: original.request_id }}
        initialAnswer={original}
        onAnswer={(a) => answers.push(a)}
        onCancel={() => undefined}
      />,
    );
    await frame(screen, '只支持 CSV');
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(answers).toEqual([original]));
    screen.unmount();
  });
  it('窄屏分页查看完整问题时输入草稿不会丢失', async () => {
    const answers: ClarificationAnswer[] = [];
    const request = { ...clarification, request_id: 'Q-compact', reason: '原因说明'.repeat(30) };
    const element = (
      <ClarificationOverlay
        locale="zh-CN"
        request={request}
        maxHeight={12}
        onAnswer={(a) => answers.push(a)}
        onCancel={() => undefined}
      />
    );
    const screen = render(element);
    vi.spyOn(screen.stdout, 'columns', 'get').mockReturnValue(36);
    screen.rerender(element);
    await frame(screen, '需要确认');
    await type(screen, 'CSV');
    screen.stdin.write('\u000f');
    await frame(screen, 'PgUp/PgDn');
    screen.stdin.write('\u001b[6~');
    await frame(screen, '原因说明');
    expect(screen.lastFrame()?.split('\n').length).toBeLessThanOrEqual(12);
    screen.stdin.write('\u000f');
    await frame(screen, '○ 管理员');
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]?.free_text).toBe('CSV');
    screen.unmount();
  });
  it('默认推荐只在 Enter 后成为答案', async () => {
    const answers: ClarificationAnswer[] = [];
    const screen = render(
      <ClarificationOverlay
        request={{ ...clarification, request_id: 'Q-test' }}
        locale="zh-CN"
        onAnswer={(a) => {
          answers.push(a);
        }}
        onCancel={() => undefined}
      />,
    );
    await frame(screen, '● 管理员');
    expect(answers).toEqual([]);
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]?.selected_option_id).toBe('recommended');
    expect(answers[0]?.free_text).toBeNull();
  });
  it('方向键选择其他选项，文字＋Tab 保留组合答案', async () => {
    const answers: ClarificationAnswer[] = [];
    const screen = render(
      <ClarificationOverlay
        request={{ ...clarification, request_id: 'Q-test' }}
        locale="zh-CN"
        onAnswer={(a) => {
          answers.push(a);
        }}
        onCancel={() => undefined}
      />,
    );
    await frame(screen, '● 管理员');
    screen.stdin.write('\u001b[B');
    await frame(screen, '● 所有用户');
    await type(screen, '限制为本页');
    await frame(screen, '○ 所有用户');
    screen.stdin.write('\t');
    await frame(screen, '● 所有用户');
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({
      selected_option_id: 'expanded',
      free_text: '限制为本页',
      source: 'user',
    });
  });
  it('直接输入是自由回答，Esc 不确认推荐项', async () => {
    const answers: ClarificationAnswer[] = [];
    let cancelled = 0;
    const screen = render(
      <ClarificationOverlay
        request={{ ...clarification, request_id: 'Q-test' }}
        locale="zh-CN"
        onAnswer={(a) => {
          answers.push(a);
        }}
        onCancel={() => {
          cancelled++;
        }}
      />,
    );
    await frame(screen, '● 管理员');
    await type(screen, '只支持 CSV');
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]?.selected_option_id).toBeNull();
    screen.stdin.write('\u001b');
    await vi.waitFor(() => expect(cancelled).toBe(1));
    expect(answers).toHaveLength(1);
  });
  it('不允许自由输入时按键不会制造文字答案', async () => {
    const answers: ClarificationAnswer[] = [];
    const screen = render(
      <ClarificationOverlay
        request={{ ...clarification, allow_custom_answer: false, request_id: 'Q-test' }}
        locale="zh-CN"
        onAnswer={(a) => {
          answers.push(a);
        }}
        onCancel={() => undefined}
      />,
    );
    await frame(screen, '● 管理员');
    screen.stdin.write('extra');
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]?.free_text).toBeNull();
  });
});

describe('Ink Session、语言与对话', () => {
  it('显示供应商上下文计数与 API 实际消耗，本次及累计独立计算', async () => {
    const fixture = temporaryManager();
    try {
      let request = 0;
      let usage = { input_tokens: 0, output_tokens: 0 };
      const client = {
        get lastUsage() {
          return usage;
        },
        countTokens: async () => 5000,
        createMessage: async () => {
          usage =
            ++request === 1
              ? { input_tokens: 4000, output_tokens: 200 }
              : { input_tokens: 4500, output_tokens: 300 };
          return [{ type: 'text' as const, text: `实际用量回答${request}` }];
        },
      };
      const screen = render(
        <TerminalApp
          manager={fixture.manager}
          getUsage={buildContextUsageReader(fixture.manager, fixture.root, 'single')}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(fixture.manager, fixture.root, settings, presenter, emit, client)
          }
        />,
      );
      await frame(screen, '上下文：待计数');
      await type(screen, '第一次请求');
      screen.stdin.write('\r');
      await frame(screen, '实际用量回答1');
      await frame(screen, '上下文（供应商计数）：5,000 / 500,000 tokens · 1.0%');
      await frame(screen, '消耗（API）：本次 4,200 · 累计 4,200 tokens');
      await type(screen, '第二次请求');
      screen.stdin.write('\r');
      await frame(screen, '实际用量回答2');
      await frame(screen, '消耗（API）：本次 4,800 · 累计 9,000 tokens');
      await type(screen, '/language en-US');
      screen.stdin.write('\r');
      await frame(screen, 'Context (provider count): 5,000 / 500,000 tokens · 1.0%');
      await frame(screen, 'Usage (API): this turn 4,800 · total 9,000 tokens');
    } finally {
      fixture.cleanup();
    }
  });
  it('底部用量在工具运行期间实时更新，切换 Session 后重置', async () => {
    const fixture = temporaryManager();
    try {
      const getUsage = buildContextUsageReader(fixture.manager, fixture.root, 'single');
      const initial = getUsage().usedTokens;
      let finish: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let count = 0;
      const screen = render(
        <TerminalApp
          manager={fixture.manager}
          getUsage={getUsage}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(fixture.manager, fixture.root, settings, presenter, emit, {
              createMessage: async () => {
                if (++count === 1) return [call('usage', 'get_spec')];
                await waiting;
                return [{ type: 'text', text: '实时用量验证完成' }];
              },
            })
          }
        />,
      );
      await frame(screen, '上下文：待计数 / 500,000 tokens');
      await type(screen, '开始工具调用');
      screen.stdin.write('\r');
      await vi.waitFor(() => expect(count).toBe(2));
      expect(fixture.manager.current.status).toBe('running');
      const used = getUsage();
      expect(used.usedTokens).toBeGreaterThan(initial);
      await frame(
        screen,
        `${used.usedTokens.toLocaleString('zh-CN')} / 500,000 tokens · ${used.percentage.toFixed(1)}%`,
      );
      finish();
      await frame(screen, '实时用量验证完成');
      await type(screen, '/new 空对话');
      screen.stdin.write('\r');
      await vi.waitFor(() => expect(fixture.manager.current.title).toBe('空对话'));
      await frame(screen, '上下文：待计数 / 500,000 tokens');
    } finally {
      fixture.cleanup();
    }
  });
  it('Tab 补全 /compact，显示压缩状态及下降的用量，压缩后可继续对话', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.beginTurn(`仅管理员，不要外传。${'旧资料'.repeat(3000)}`);
      fixture.manager.messages.push(
        { role: 'assistant', content: '已读取旧资料' },
        { role: 'user', content: '未决：编码' },
        { role: 'assistant', content: '等待确认编码' },
        { role: 'user', content: '采用 UTF-8' },
        { role: 'assistant', content: '已确认 UTF-8' },
      );
      fixture.manager.completeTurn();
      const original = structuredClone(fixture.manager.messages);
      const getUsage = buildContextUsageReader(fixture.manager, fixture.root, 'single');
      const before = getUsage().usedTokens;
      let finish: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const exposed: number[] = [];
      const screen = render(
        <TerminalApp
          manager={fixture.manager}
          getUsage={getUsage}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(fixture.manager, fixture.root, settings, presenter, emit, {
              createMessage: async (messages, tools) => {
                exposed.push(tools.length);
                if (!tools.length) {
                  await waiting;
                  return [
                    {
                      type: 'text',
                      text: '用户仅允许管理员操作，禁止外传；编码采用 UTF-8，证据为消息4。',
                    },
                  ];
                }
                expect(messages[0]?.content).toContain('禁止外传');
                return [{ type: 'text', text: '压缩后继续成功' }];
              },
            })
          }
        />,
      );
      await frame(screen, '等待输入');
      await type(screen, '/comp');
      await frame(screen, '/compact — 压缩当前上下文');
      screen.stdin.write('\t');
      await frame(screen, '› /compact');
      screen.stdin.write('\r');
      await frame(screen, '正在压缩上下文');
      screen.stdin.write('\u0011');
      await frame(screen, '不能安全中断');
      expect(fixture.manager.current.status).toBe('waiting_for_user');
      finish();
      await frame(screen, '上下文已压缩');
      expect(fixture.manager.messages).toEqual(original);
      expect(getUsage().usedTokens).toBeLessThan(before);
      await frame(screen, `${getUsage().usedTokens.toLocaleString('zh-CN')} / 500,000 tokens`);
      await type(screen, '继续任务');
      screen.stdin.write('\r');
      await frame(screen, '压缩后继续成功');
      expect(exposed).toEqual([0, 5]);
      expect(fixture.manager.current.status).toBe('waiting_for_user');
      await type(screen, '/language en-US');
      screen.stdin.write('\r');
      await frame(screen, 'Context (estimated):');
    } finally {
      fixture.cleanup();
    }
  });
  it('手动压缩失败保留原上下文和生命周期，错误不回显密钥', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.beginTurn('旧资料'.repeat(3000));
      fixture.manager.messages.push(
        { role: 'assistant', content: '旧回答' },
        { role: 'user', content: '新问题' },
      );
      fixture.manager.completeTurn();
      const original = fixture.manager.current;
      const screen = render(
        <TerminalApp
          manager={fixture.manager}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(fixture.manager, fixture.root, settings, presenter, emit, {
              createMessage: async () => {
                throw new Error('secret-token');
              },
            })
          }
        />,
      );
      await frame(screen, '等待输入');
      await type(screen, '/compact');
      screen.stdin.write('\r');
      await frame(screen, '上下文压缩失败');
      expect(fixture.manager.messages).toEqual(original.messages);
      expect(fixture.manager.context).toEqual(original.context);
      expect(fixture.manager.current.status).toBe(original.status);
      expect(fixture.manager.current.token_usage.total.unreported_requests).toBe(1);
      expect(screen.lastFrame()).not.toContain('secret-token');
      expect(screen.lastFrame()).not.toContain('本轮已标记为中断');
    } finally {
      fixture.cleanup();
    }
  });
  it('应用卸载唤醒待回答澄清，运行中的 Ctrl+Q 不能切换或退出', async () => {
    const fixture = temporaryManager();
    try {
      const client = new ScriptedClient([
        readyIntake,
        [call('q', 'request_clarification', clarification)],
        [{ type: 'text', text: '取消后返回' }],
      ]);
      const screen = render(
        <TerminalApp
          manager={fixture.manager}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(fixture.manager, fixture.root, settings, presenter, emit, client)
          }
        />,
      );
      await frame(screen, '等待输入');
      await type(screen, '/clarify 导出功能');
      screen.stdin.write('\r');
      await frame(screen, '谁可以导出');
      screen.stdin.write('\u0011');
      await frame(screen, '不能安全中断');
      expect(fixture.manager.current.status).toBe('running');
      screen.unmount();
      await vi.waitFor(() => expect(fixture.manager.current.status).toBe('waiting_for_user'));
      const results = fixture.manager.messages.flatMap((m) =>
        typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_result'),
      );
      expect(results[0] && JSON.parse(results[0].content).status).toBe('cancelled');
    } finally {
      fixture.cleanup();
    }
  });
  it('Session 选择器从活动项所在页打开，翻页与取消不写状态', async () => {
    const fixture = temporaryManager();
    try {
      const sessions = [
        fixture.manager.current,
        ...Array.from({ length: 11 }, (_, i) => fixture.manager.create(`对话${i + 1}`)),
      ];
      const activeId = sessions[11]?.session_id ?? '';
      let selected = '';
      let cancelled = false;
      const screen = render(
        <SessionOverlay
          sessions={sessions}
          activeId={activeId}
          locale="zh-CN"
          onSelect={(id) => {
            selected = id;
          }}
          onCancel={() => {
            cancelled = true;
          }}
        />,
      );
      await frame(screen, '第 2/2 页');
      screen.stdin.write('\u001b[5~');
      await frame(screen, '第 1/2 页');
      screen.stdin.write('\u001b[6~');
      await frame(screen, '第 2/2 页');
      screen.stdin.write('\r');
      await vi.waitFor(() => expect(selected).toBe(activeId));
      screen.stdin.write('\u001b');
      await vi.waitFor(() => expect(cancelled).toBe(true));
      expect(fixture.manager.current.session_id).toBe(activeId);
    } finally {
      fixture.cleanup();
    }
  });
  it('命令提示、Tab 补全、新建、改名、状态与语言切换不调用模型', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.messages.push({ role: 'user', content: '保留原有中文历史' });
      const screen = render(
        <TerminalApp
          manager={fixture.manager}
          runtimeFactory={() => {
            throw new Error('命令不得调用模型');
          }}
        />,
      );
      await frame(screen, '保留原有中文历史');
      await type(screen, '/sta');
      await frame(screen, '/status');
      screen.stdin.write('\t');
      await frame(screen, '› /status');
      screen.stdin.write('\r');
      await frame(screen, '当前 Session');
      await type(screen, '/language en-US');
      screen.stdin.write('\r');
      await frame(screen, 'Ready');
      await frame(screen, '保留原有中文历史');
      await type(screen, '/new 新会话');
      screen.stdin.write('\r');
      await vi.waitFor(() => expect(fixture.manager.current.title).toBe('新会话'));
      await type(screen, '/rename 新标题');
      screen.stdin.write('\r');
      await vi.waitFor(() => expect(fixture.manager.current.title).toBe('新标题'));
      await type(screen, '/switch');
      screen.stdin.write('\r');
      await frame(screen, 'Switch Session');
      screen.stdin.write('\u001b');
      await frame(screen, '›');
      await type(screen, '/quit');
      screen.stdin.write('\r');
    } finally {
      fixture.cleanup();
    }
  });
  it('PgUp 停止尾部跟随，Ctrl+End 回到底部，角色不依赖翻译', async () => {
    const fixture = temporaryManager();
    try {
      for (let i = 1; i <= 40; i++)
        fixture.manager.messages.push({
          role: i % 2 ? 'user' : 'assistant',
          content: `历史消息${i}`,
        });
      const screen = render(
        <TerminalApp
          manager={fixture.manager}
          runtimeFactory={() => {
            throw new Error('不得调用模型');
          }}
        />,
      );
      await frame(screen, '历史消息40');
      screen.stdin.write('\u001b[5~');
      await frame(screen, '历史消息20');
      expect(screen.lastFrame()).not.toContain('历史消息40');
      screen.stdin.write('\u001b[1;5H');
      await frame(screen, '你：历史消息1');
      screen.stdin.write('\u001b[1;5F');
      await frame(screen, '历史消息40');
    } finally {
      fixture.cleanup();
    }
  });
  it('同一应用澄清、运行并保存 Session，无嵌套终端', async () => {
    const fixture = temporaryManager();
    try {
      const client = new ScriptedClient([
        readyIntake,
        [call('q', 'request_clarification', clarification)],
        [{ type: 'text', text: '已收到回答' }],
      ]);
      const screen = render(
        <TerminalApp
          manager={fixture.manager}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(fixture.manager, fixture.root, settings, presenter, emit, client)
          }
        />,
      );
      await frame(screen, '等待输入');
      await type(screen, '/clarify 导出需求');
      screen.stdin.write('\r');
      await frame(screen, '谁可以导出');
      await type(screen, '只支持本页');
      screen.stdin.write('\r');
      await frame(screen, '已收到回答');
      expect(fixture.manager.current.status).toBe('waiting_for_user');
      const result = fixture.manager.messages.flatMap((m) =>
        typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_result'),
      )[0];
      expect(result && JSON.parse(result.content).answer.free_text).toBe('只支持本页');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('非 TTY 与 npm CLI 入口', () => {
  it('管道 /compact 不成为用户请求，保存摘要并继续下一轮；多余参数不调用模型', async () => {
    const fixture = temporaryManager();
    try {
      fixture.manager.beginTurn(`仅管理员。${'旧资料'.repeat(3000)}`);
      fixture.manager.messages.push(
        { role: 'assistant', content: '旧回答' },
        { role: 'user', content: '继续' },
      );
      fixture.manager.completeTurn();
      const count = fixture.manager.messages.length;
      const client = new ScriptedClient([
        [{ type: 'text', text: '仅管理员；资料已阅读。' }],
        [{ type: 'text', text: '继续成功' }],
      ]);
      let output = '';
      await runConsole(
        fixture.manager,
        (presenter, emit) =>
          buildSessionRuntime(fixture.manager, fixture.root, settings, presenter, emit, client),
        Readable.from(['/compact extra\n/compact\n继续需求\n/quit\n']),
        new Writable({
          write(chunk, _encoding, done) {
            output += String(chunk);
            done();
          },
        }),
        buildContextUsageReader(fixture.manager, fixture.root, 'single'),
      );
      expect(output).toContain('用法：/compact');
      expect(output).toContain('上下文已压缩');
      expect(output).toContain('继续成功');
      expect(output).toContain('/ 500,000 tokens');
      expect(output).not.toContain('\u001b');
      expect(fixture.manager.messages).toHaveLength(count + 2);
      expect(client.exposedTools.map((t) => t.length)).toEqual([0, 5]);
    } finally {
      fixture.cleanup();
    }
  });
  it('一次管道包含命令、选择、澄清和回答时不丢输入，不输出 ANSI', async () => {
    const fixture = temporaryManager();
    try {
      const client = new ScriptedClient([
        readyIntake,
        [call('q', 'request_clarification', clarification)],
        [{ type: 'text', text: '管道回答已收到' }],
      ]);
      let output = '';
      const stdout = new Writable({
        write(chunk, _encoding, done) {
          output += String(chunk);
          done();
        },
      });
      await runConsole(
        fixture.manager,
        (presenter, emit) =>
          buildSessionRuntime(fixture.manager, fixture.root, settings, presenter, emit, client),
        Readable.from(['/new 管道会话\n/status\n/clarify 导出需求\n2\n/switch\nq\n/quit\n']),
        stdout,
      );
      expect(output).toContain('管道回答已收到');
      expect(output).not.toContain('\u001b');
      expect(fixture.manager.current.title).toBe('管道会话');
      expect(client.exposedTools).toHaveLength(3);
    } finally {
      fixture.cleanup();
    }
  });
  it('帮助和版本不要求配置，逐行启动可操作 Session 命令', () => {
    const fixture = temporaryManager();
    try {
      const executable = resolve('src/cli.tsx');
      const invoke = (args: string[], input = '') =>
        execFileSync(
          process.execPath,
          [
            '--import',
            pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
            executable,
            ...args,
          ],
          {
            cwd: fixture.root,
            input,
            encoding: 'utf8',
            env: {
              ...process.env,
              HOME: fixture.root,
              USERPROFILE: fixture.root,
              ANTHROPIC_API_KEY: 'offline',
              MODEL_ID: 'fake',
            },
          },
        );
      const help = invoke(['--help']);
      expect(help).toContain('/done');
      expect(help).toContain('/compact');
      expect(invoke(['--version'])).toBe('0.1.0\n');
      const output = invoke([], '/new CLI会话\n/rename CLI标题\n/status\n/quit\n');
      expect(output).toContain('CLI标题');
      expect(output).not.toContain('\u001b');
    } finally {
      fixture.cleanup();
    }
  });
  it('两种语言词条完整，文本安全和协议过滤保持结构化角色', () => {
    expect(Object.keys(catalogs['zh-CN']).sort()).toEqual(Object.keys(catalogs['en-US']).sort());
    expect(resolveLocale('EN_us')).toBe('en-US');
    expect(resolveLocale('zh')).toBe('zh-CN');
    expect(resolveLocale('unknown')).toBeNull();
    expect(safeTerminalText('标题\u001b\n\u0007')).toBe('标题');
    expect(
      readableTranscript([
        { role: 'assistant', content: [call('1', 'get_spec')] },
        { role: 'user', content: 'SpecPilot 也可以是用户文字' },
      ]),
    ).toEqual([{ role: 'user', text: 'SpecPilot 也可以是用户文字' }]);
    expect(commands).toContain('/language');
    expect(commands).toContain('/compact');
    const fixture = temporaryManager();
    try {
      expect(handleSessionCommand('/done', fixture.manager, () => undefined)).toBe('not_command');
      expect(handleSessionCommand('/unknown', fixture.manager, () => undefined)).toBe('handled');
      expect(handleSessionCommand('/rename', fixture.manager, () => undefined)).toBe('handled');
    } finally {
      fixture.cleanup();
    }
  });
});

import { Readable, Writable } from 'node:stream';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionRuntime } from '../src/bootstrap.js';
import { questionRequest } from '../src/capabilities/clarification/plan.js';
import { TerminalApp } from '../src/integrations/terminal/app.js';
import { runConsole } from '../src/integrations/terminal/console.js';
import type { ModelBlock } from '../src/runtime/model.js';
import { call, clarification, required, ScriptedClient, temporaryManager } from './helpers.js';

afterEach(cleanup);
const settings = { api_key: 'offline', model: 'fake', max_tool_use_turns: 20 };
const round = () => ({
  expected_version: 0,
  topics: [
    { id: 'scope', title: '目标与范围', needs_detail: false },
    { id: 'storage', title: '存储规则', needs_detail: true },
  ],
  questions: ['users', 'files'].map((id) => ({
    id,
    topic_id: 'scope',
    input: { ...clarification, question: id === 'users' ? '谁可以导出？' : '需要哪些文件？' },
    statement: id === 'users' ? '谁可以导出？' : '需要哪些文件？',
    blocking: true,
    depends_on: [],
    open_question_id: null,
    spec_entity_ids: [],
    status: 'pending' as const,
    change_reason: '先确认基本场景',
  })),
  question_ids: ['users', 'files'],
  summary: '先确认基本场景，存储待细化',
});
type Screen = ReturnType<typeof render>;
const frame = async (screen: Screen, text: string) =>
  vi.waitFor(() => expect(screen.lastFrame()).toContain(text));
const type = async (screen: Screen, text: string) => {
  screen.stdin.write(text);
  await frame(screen, text);
};
const command = async (screen: Screen, text: string) => {
  await type(screen, text);
  screen.stdin.write('\r');
};

describe('多轮清单实际按键', () => {
  it('默认组合根发布后显示总览，任意顺序草稿零模型调用，暂缓、历史、部分提交', async () => {
    const f = temporaryManager();
    try {
      const client = new ScriptedClient([
        [call('plan', 'publish_clarification_round', round())],
        [{ type: 'text', text: '待进一步细化' }],
      ]);
      const screen = render(
        <TerminalApp
          manager={f.manager}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(f.manager, f.root, settings, presenter, emit, client)
          }
        />,
      );
      await frame(screen, '等待输入');
      await command(screen, '上传功能');
      await frame(screen, '澄清总览');
      expect(client.exposedTools).toHaveLength(1);
      screen.stdin.write('\u001b[B');
      await frame(screen, '> 需要哪些文件');
      screen.stdin.write('\r');
      await frame(screen, '需要确认：需要哪些文件');
      await type(screen, '只要 CSV');
      screen.stdin.write('\t');
      await frame(screen, '● 管理员');
      screen.stdin.write('\r');
      await frame(screen, '当前回答');
      expect(f.manager.clarification.get().answers[0]?.question_id).toBe('files');
      expect(f.manager.clarification.get().answers[0]?.answer).toMatchObject({
        selected_option_id: 'recommended',
        free_text: '只要 CSV',
      });
      expect(client.exposedTools).toHaveLength(1);
      screen.stdin.write('h');
      await frame(screen, '答案修订历史');
      screen.stdin.write('\u001b');
      await frame(screen, '澄清总览');
      screen.stdin.write('\u001b[A');
      await frame(screen, '> 谁可以导出');
      screen.stdin.write('d');
      await frame(screen, '暂缓');
      screen.stdin.write('c');
      await vi.waitFor(() => expect(client.exposedTools).toHaveLength(2));
      expect(f.manager.clarification.get().answers[0]?.submission_id).not.toBeNull();
      screen.unmount();
    } finally {
      f.cleanup();
    }
  });
  it('查看全部主题和旧答案、取消不产生答案，中英文仍可操作', async () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(round());
      const client = new ScriptedClient([]);
      const screen = render(
        <TerminalApp
          manager={f.manager}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(f.manager, f.root, settings, presenter, emit, client)
          }
        />,
      );
      await frame(screen, '等待输入');
      await command(screen, '/clarify');
      await frame(screen, '澄清总览');
      screen.stdin.write('\r');
      await frame(screen, '需要确认');
      screen.stdin.write('\u001b');
      await frame(screen, '澄清总览');
      expect(f.manager.clarification.get().answers).toEqual([]);
      screen.stdin.write('\t');
      await frame(screen, '全部主题');
      for (let i = 0; i < 4; i++) {
        screen.stdin.write('\u001b[B');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await frame(screen, '存储规则');
      await frame(screen, '待细化');
      screen.stdin.write('b');
      await frame(screen, '等待输入');
      await command(screen, '/language en');
      await frame(screen, 'Ready');
      await command(screen, '/clarify');
      await frame(screen, 'Clarification map');
      expect(client.exposedTools).toHaveLength(0);
      screen.unmount();
    } finally {
      f.cleanup();
    }
  });
  it('/done 保留草稿并只总结已有内容', async () => {
    const f = temporaryManager();
    try {
      f.manager.clarification.publish(round());
      const q = required(f.manager.clarification.get().questions[0]);
      f.manager.editClarification({
        session_id: f.manager.current.session_id,
        question_id: q.id,
        question_version: q.version,
        answer: {
          request_id: questionRequest(q).request_id,
          selected_option_id: 'recommended',
          free_text: null,
          source: 'user',
        },
      });
      const client = new ScriptedClient([[{ type: 'text', text: '已确认和未决事项' }]]);
      const screen = render(
        <TerminalApp
          manager={f.manager}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(f.manager, f.root, settings, presenter, emit, client)
          }
        />,
      );
      await command(screen, '/clarify');
      await frame(screen, '澄清总览');
      screen.stdin.write('x');
      await frame(screen, '已确认和未决事项');
      expect(f.manager.clarification.get().answers[0]?.submission_id).toBeNull();
      expect(client.exposedTools[0]).toEqual([]);
      screen.unmount();
    } finally {
      f.cleanup();
    }
  });
  it('运行期间总览只读，重复继续不会重复调用模型', async () => {
    const f = temporaryManager();
    let finish: ((blocks: ModelBlock[]) => void) | undefined;
    try {
      f.manager.clarification.publish(round());
      const q = f.manager.clarification.get().questions[0];
      if (!q) throw new Error('缺少问题');
      f.manager.editClarification({
        session_id: f.manager.current.session_id,
        question_id: q.id,
        question_version: q.version,
        answer: {
          request_id: questionRequest(q).request_id,
          selected_option_id: 'recommended',
          free_text: null,
          source: 'user',
        },
      });
      const createMessage = vi.fn(
        () =>
          new Promise<ModelBlock[]>((resolve) => {
            finish = resolve;
          }),
      );
      const screen = render(
        <TerminalApp
          manager={f.manager}
          runtimeFactory={(presenter, emit) =>
            buildSessionRuntime(f.manager, f.root, settings, presenter, emit, { createMessage })
          }
        />,
      );
      await command(screen, '/clarify');
      await frame(screen, '澄清总览');
      screen.stdin.write('c');
      await frame(screen, '只能查看');
      screen.stdin.write('c');
      screen.stdin.write('d');
      screen.stdin.write('\r');
      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(f.manager.clarification.get().questions[0]?.status).toBe('submitted');
      finish?.([{ type: 'text', text: '返回用户' }]);
      await vi.waitFor(() => expect(f.manager.current.status).toBe('waiting_for_user'));
      screen.unmount();
    } finally {
      finish?.([{ type: 'text', text: '结束测试' }]);
      f.cleanup();
    }
  });
});

it('Console 与 TUI 等价：主题总览、组合草稿、暂缓、部分提交、结束和恢复', async () => {
  const f = temporaryManager();
  try {
    let output = '';
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const client = new ScriptedClient([
      [call('plan', 'publish_clarification_round', round())],
      [{ type: 'text', text: '下一轮可以继续' }],
      [{ type: 'text', text: '最终总结' }],
    ]);
    await runConsole(
      f.manager,
      (presenter, emit) =>
        buildSessionRuntime(f.manager, f.root, settings, presenter, emit, client),
      Readable.from(['上传\na\nh 1\nd 1\n2\n只要 CSV\nc\nx\nq\n']),
      stdout,
    );
    expect(output).toContain('存储规则');
    expect(output).toContain('待细化');
    expect(output).toContain('暂缓');
    expect(output).toContain('最终总结');
    expect(output).not.toContain('\u001b');
    expect(client.exposedTools).toHaveLength(3);
    expect(client.exposedTools[2]).toEqual([]);
    expect(f.manager.clarification.get().answers[0]?.question_id).toBe('files');
    expect(f.manager.clarification.get().questions[0]?.status).toBe('deferred');
  } finally {
    f.cleanup();
  }
});

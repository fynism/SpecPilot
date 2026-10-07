import { createInterface } from 'node:readline';
import {
  answerSchema,
  type ClarificationPresenter,
  type ClarificationRequest,
} from '../../capabilities/clarification/models.js';
import { ClarificationCancelled } from '../../capabilities/clarification/tool.js';
import type { SessionManager } from '../../runtime/session/manager.js';
import { runSessionTurn } from '../../runtime/turn.js';
import type { RuntimeFactory } from './app.js';
import { handleSessionCommand, statusText } from './commands.js';
import { readableTranscript, safeTerminalText } from './text.js';

/** 一个共享逐行队列同时供命令与澄清消费，预先管道化的输入不会丢失。 */
export class ConsoleInput {
  private readonly lines: AsyncIterator<string>;
  private readonly reader;
  constructor(input: NodeJS.ReadableStream) {
    this.reader = createInterface({ input, terminal: false });
    this.lines = this.reader[Symbol.asyncIterator]();
  }
  async read(): Promise<string | null> {
    const next = await this.lines.next();
    return next.done ? null : next.value;
  }
  close(): void {
    this.reader.close();
  }
}

export class ConsoleClarificationPresenter implements ClarificationPresenter {
  constructor(
    private readonly input: ConsoleInput,
    private readonly emit: (text: string) => void,
  ) {}
  async ask(request: ClarificationRequest) {
    this.emit(request.question);
    this.emit(`为什么需要确认：${request.reason}`);
    const recommended =
      request.options.findIndex((o) => o.id === request.recommended_option_id) + 1;
    for (const [i, option] of request.options.entries())
      this.emit(
        `${i + 1}. ${option.label}${i + 1 === recommended ? ' [推荐]' : ''} · ${option.description}`,
      );
    this.emit(`推荐理由：${request.recommendation_reason}`);
    while (true) {
      this.emit(
        `请选择 [${recommended}]${request.allow_custom_answer ? '，或直接输入回答' : ''}；输入 q 取消：`,
      );
      const raw = await this.input.read();
      if (raw === null) throw new ClarificationCancelled();
      const value = raw.trim();
      if (['q', 'quit', 'cancel', '\u001b', '\u0003'].includes(value.toLowerCase()))
        throw new ClarificationCancelled();
      if (value === '' || /^\d+$/.test(value)) {
        const number = value ? Number(value) : recommended;
        const option = request.options[number - 1];
        if (option)
          return answerSchema.parse({
            request_id: request.request_id,
            selected_option_id: option.id,
          });
      } else if (request.allow_custom_answer) {
        const parsed = answerSchema.safeParse({ request_id: request.request_id, free_text: value });
        if (parsed.success) return parsed.data;
      }
      this.emit('请选择有效选项，或输入不超过 1000 字符的回答。');
    }
  }
}

/** 非 TTY 不使用 Ink 和控制序列，命令、Session 和 Agent 能力保持一致。 */
export async function runConsole(
  manager: SessionManager,
  runtimeFactory: RuntimeFactory,
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const input = new ConsoleInput(stdin);
  const emit = (text: string) => {
    stdout.write(`${safeTerminalText(text, true)}\n`);
  };
  const presenter = new ConsoleClarificationPresenter(input, emit);
  const present = () => {
    emit(statusText(manager));
    if (manager.current.status === 'interrupted')
      emit('上一轮未完整结束，系统不会自动重放模型或工具调用。');
    const entries = readableTranscript(manager.messages);
    if (entries.length > 10) emit(`── 更早还有 ${entries.length - 10} 条可读消息未显示 ──`);
    for (const entry of entries.slice(-10))
      emit(
        `${entry.role === 'user' ? '你' : 'SpecPilot'}：${Array.from(entry.text).slice(0, 800).join('')}`,
      );
  };
  try {
    present();
    while (true) {
      emit('SpecPilot >>');
      const query = await input.read();
      if (query === null || ['q', 'exit', ''].includes(query.trim().toLowerCase())) return;
      if (query.trim().toLowerCase() === '/switch') {
        const sessions = manager.listSessions();
        for (const [i, session] of sessions.entries()) {
          emit(`${i + 1}. ${session.title} · ${session.session_id} · ${session.status}`);
        }
        while (true) {
          emit('请输入 Session 编号；输入 q 取消：');
          const choice = await input.read();
          if (
            choice === null ||
            ['q', 'quit', 'cancel', '', '\u001b', '\u0003'].includes(choice.trim().toLowerCase())
          )
            break;
          const selected = /^\d+$/.test(choice.trim())
            ? sessions[Number(choice.trim()) - 1]
            : undefined;
          if (!selected) {
            emit('请选择列表中的有效编号。');
            continue;
          }
          handleSessionCommand(`/switch ${selected.session_id}`, manager, emit);
          present();
          break;
        }
        continue;
      }
      if (/^\/language(?:\s|$)/i.test(query.trim())) {
        emit('界面语言切换仅适用于全屏 TUI。');
        continue;
      }
      try {
        const result = handleSessionCommand(query, manager, emit);
        if (result === 'quit') return;
        if (result === 'session_changed') {
          present();
          continue;
        }
        if (result === 'handled') continue;
        const reason = await runSessionTurn(manager, runtimeFactory(presenter, emit), query);
        if (reason === 'stop') return;
        if (reason === 'max_tool_use_turns') emit('本轮达到工具调用上限，可继续下一轮。');
        const last = manager.messages.at(-1);
        if (last?.role === 'assistant')
          for (const entry of readableTranscript([last])) emit(entry.text);
      } catch (error) {
        emit(
          `Agent 运行失败：${error instanceof Error ? error.name : 'UnknownError'}。当前轮次已标记为中断。`,
        );
      }
    }
  } finally {
    input.close();
  }
}

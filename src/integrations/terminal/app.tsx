import { Spinner } from '@inkjs/ui';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type {
  ClarificationAnswer,
  ClarificationPresenter,
  ClarificationRequest,
} from '../../capabilities/clarification/models.js';
import { ClarificationCancelled } from '../../capabilities/clarification/tool.js';
import type { AgentRuntime, StopReason } from '../../runtime/agent.js';
import {
  buildContextMessages,
  type ContextUsage,
  estimateContextUsage,
} from '../../runtime/context/index.js';
import { ContextLimitError } from '../../runtime/model.js';
import { SYSTEM } from '../../runtime/prompts.js';
import type { SessionManager } from '../../runtime/session/manager.js';
import { compactSession, runSessionTurn } from '../../runtime/turn.js';
import { commands, handleSessionCommand } from './commands.js';
import { type Locale, resolveLocale, type TextKey, translate } from './i18n.js';
import { InputLine } from './input.js';
import { ClarificationOverlay, LanguageOverlay, SessionOverlay } from './overlays.js';
import { readableTranscript, safeTerminalText } from './text.js';

export type RuntimeFactory = (
  presenter: ClarificationPresenter,
  emit: (text: string) => void,
) => AgentRuntime;
interface PendingQuestion {
  request: ClarificationRequest;
  resolve(answer: ClarificationAnswer): void;
  reject(error: ClarificationCancelled): void;
}

function terminalDimensions(stdout: NodeJS.WritableStream): { rows: number; columns: number } {
  const rows = 'rows' in stdout && typeof stdout.rows === 'number' ? stdout.rows : 24;
  const columns = 'columns' in stdout && typeof stdout.columns === 'number' ? stdout.columns : 80;
  return { rows: rows || 24, columns: columns || 80 };
}

/** 一个 Ink 应用独占全屏；异步 Runtime 只通过注入事件与澄清端口更新 UI。 */
export function TerminalApp({
  manager,
  runtimeFactory,
  getUsage,
}: {
  manager: SessionManager;
  runtimeFactory: RuntimeFactory;
  getUsage?: () => ContextUsage;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState(terminalDimensions(stdout));
  const [locale, setLocale] = useState<Locale>('zh-CN');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState<TextKey>('status.waiting');
  const [overlay, setOverlay] = useState<'sessions' | 'language' | null>(null);
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const pending = useRef<PendingQuestion | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [prefix, setPrefix] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [offset, setOffset] = useState<number | null>(null);
  const [revision, refresh] = useState(0);
  const mounted = useRef(true);
  const t = (key: TextKey, values?: Record<string, string | number>) =>
    translate(locale, key, values);
  useEffect(() => {
    mounted.current = true;
    const resize = () => setDimensions(terminalDimensions(stdout));
    stdout.on('resize', resize);
    return () => {
      mounted.current = false;
      stdout.off('resize', resize);
      // 应用退出必须唤醒澄清等待者，不能遗留永不完成的 Promise。
      pending.current?.reject(new ClarificationCancelled());
      pending.current = null;
    };
  }, [stdout]);
  const presenter: ClarificationPresenter = {
    ask: (request) =>
      new Promise((resolve, reject) => {
        const waiting = { request, resolve, reject };
        pending.current = waiting;
        if (!mounted.current) {
          reject(new ClarificationCancelled());
          return;
        }
        setQuestion(waiting);
        setStatus('status.clarification');
      }),
  };
  const emit = (text: string) => {
    if (mounted.current) {
      setNotice(safeTerminalText(text));
      refresh((r) => r + 1);
    }
  };
  const submit = async (query: string): Promise<void> => {
    if (busyRef.current || !query.trim()) return;
    setEpoch((e) => e + 1);
    setPrefix('');
    setHistory((h) => [...h, query]);
    setOffset(null);
    if (query.trim().toLowerCase() === '/switch') {
      setOverlay('sessions');
      return;
    }
    const language = /^\/language(?:\s+(.*))?$/i.exec(query.trim());
    if (language) {
      if (!language[1]) setOverlay('language');
      else {
        const resolved = resolveLocale(language[1]);
        if (resolved) {
          setLocale(resolved);
          setNotice(translate(resolved, 'notice.locale_changed'));
        } else setNotice(t('notice.locale_invalid', { locale: safeTerminalText(language[1]) }));
      }
      return;
    }
    let compacting = false;
    try {
      const result = handleSessionCommand(query, manager, emit);
      if (result === 'quit') {
        exit();
        return;
      }
      if (result !== 'not_command' && result !== 'compact') {
        refresh((r) => r + 1);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      compacting = result === 'compact';
      setStatus(compacting ? 'status.compacting' : 'status.running');
      const runtime = runtimeFactory(presenter, emit);
      let reason: StopReason | 'stop' = 'model_complete';
      if (compacting) await compactSession(manager, runtime);
      else reason = await runSessionTurn(manager, runtime, query);
      if (mounted.current) {
        setStatus(reason === 'max_tool_use_turns' ? 'status.tool_limit' : 'status.waiting');
        refresh((r) => r + 1);
      }
    } catch (error) {
      if (mounted.current) {
        setStatus('status.waiting');
        setNotice(
          t(compacting ? 'status.compaction_failure' : 'status.failure', {
            error:
              error instanceof ContextLimitError
                ? error.message
                : error instanceof Error
                  ? error.name
                  : 'UnknownError',
          }),
        );
        refresh((r) => r + 1);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const transcript = readableTranscript(manager.messages);
  const lines = transcript.flatMap((entry) => {
    const width = Math.max(10, dimensions.columns - 6);
    const label = entry.role === 'user' ? t('role.user') : t('role.assistant');
    return `${label}：${entry.text}`.split('\n').flatMap((line) => {
      // 全屏对话按字符宽度保守切片，中文与 emoji 算两列以免超出可视区。
      const wrapped: { role: typeof entry.role; text: string }[] = [];
      let part = '';
      let columns = 0;
      for (const char of line) {
        const size = (char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
        if (columns + size > width) {
          wrapped.push({ role: entry.role, text: part });
          part = '';
          columns = 0;
        }
        part += char;
        columns += size;
      }
      wrapped.push({ role: entry.role, text: part });
      return wrapped;
    });
  });
  const viewHeight = Math.max(3, dimensions.rows - 11);
  const start = Math.min(
    offset ?? Math.max(0, lines.length - viewHeight),
    Math.max(0, lines.length - viewHeight),
  );
  useInput((input, key) => {
    if ((key.ctrl && input === 'q') || (key.ctrl && input === 'c' && !question)) {
      if (busyRef.current) emit(t('notice.cannot_cancel'));
      else exit();
    }
    if (overlay || question) return;
    if (key.pageUp) setOffset(Math.max(0, start - viewHeight));
    if (key.pageDown) {
      const next = start + viewHeight;
      setOffset(next >= lines.length - viewHeight ? null : next);
    }
    if (key.ctrl && key.home) setOffset(0);
    if (key.ctrl && key.end) setOffset(null);
  });
  const session = manager.current;
  const spec = manager.currentSpec();
  const usage =
    getUsage?.() ??
    estimateContextUsage(buildContextMessages(manager.messages, manager.context, spec), [], SYSTEM);
  const candidates =
    prefix.startsWith('/') && !/\s/.test(prefix)
      ? commands.filter((c) => c.startsWith(prefix.toLowerCase()))
      : [];
  return (
    <Box flexDirection="column" height={dimensions.rows} width={dimensions.columns}>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        flexShrink={0}
      >
        <Text bold wrap="truncate-end">
          SpecPilot · {safeTerminalText(session.title)} · {session.session_id}
        </Text>
        <Text dimColor wrap="truncate-end">
          {t('header.spec')} {spec.spec_id} · v{spec.version} · {spec.status} · {session.status}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" paddingX={1}>
        {question ? (
          <ClarificationOverlay
            key={question.request.request_id}
            locale={locale}
            request={question.request}
            onCancel={() => {
              const waiting = pending.current;
              pending.current = null;
              setQuestion(null);
              setStatus('status.continuing');
              waiting?.reject(new ClarificationCancelled());
            }}
            onAnswer={(answer) => {
              const waiting = pending.current;
              pending.current = null;
              setQuestion(null);
              setStatus('status.continuing');
              waiting?.resolve(answer);
            }}
          />
        ) : overlay === 'sessions' ? (
          <SessionOverlay
            sessions={manager.listSessions()}
            activeId={session.session_id}
            locale={locale}
            onCancel={() => setOverlay(null)}
            onSelect={(id) => {
              try {
                manager.switch(id);
                setOffset(null);
                refresh((r) => r + 1);
              } catch (error) {
                emit(
                  t('notice.switch_failed', {
                    error: error instanceof Error ? error.name : 'UnknownError',
                  }),
                );
              }
              setOverlay(null);
            }}
          />
        ) : overlay === 'language' ? (
          <LanguageOverlay
            locale={locale}
            onCancel={() => setOverlay(null)}
            onSelect={(value) => {
              setLocale(value);
              setOverlay(null);
              setNotice(translate(value, 'notice.locale_changed'));
            }}
          />
        ) : lines.length ? (
          lines.slice(start, start + viewHeight).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 只渲染无状态的固定行位置，不包含可重排组件状态。
            <Text key={`${revision}:${start + i}`} color={line.role === 'user' ? 'cyan' : 'green'}>
              {line.text}
            </Text>
          ))
        ) : (
          <>
            <Text>{t('transcript.welcome')}</Text>
            <Text dimColor>{t('transcript.get_started')}</Text>
          </>
        )}
      </Box>
      <Box flexDirection="column" flexShrink={0} paddingX={1}>
        {session.status === 'interrupted' ? (
          <Text color="yellow">{t('notice.interrupted')}</Text>
        ) : null}
        {notice ? (
          <Text dimColor wrap="truncate-end">
            {notice}
          </Text>
        ) : null}
        {busy ? <Spinner label={t(status)} /> : <Text color="cyan">{t(status)}</Text>}
        <Text dimColor wrap="truncate-end">
          {t('context.usage', {
            used: usage.usedTokens.toLocaleString(locale),
            window: usage.window.toLocaleString(locale),
            percentage: usage.percentage.toFixed(1),
          })}
        </Text>
        {!busy && !overlay ? (
          <>
            {candidates.length ? (
              <Text dimColor wrap="truncate-end">
                {candidates
                  .map((c) => {
                    const name = c.slice(1);
                    return `${t(`command.${name}.usage` as TextKey)} — ${t(`command.${name}.description` as TextKey)}`;
                  })
                  .join(' · ')}
              </Text>
            ) : null}
            <InputLine
              key={epoch}
              history={history}
              onChange={setPrefix}
              onSubmit={(value) => {
                void submit(value);
              }}
              onSpecial={(value, input, key) => {
                if (key.ctrl || key.pageUp || key.pageDown) return true;
                if (key.tab)
                  return (
                    commands.find(
                      (c) =>
                        value.startsWith('/') &&
                        !/\s/.test(value) &&
                        c.startsWith(value.toLowerCase()),
                    ) ?? true
                  );
                return input === '' && key.escape;
              }}
            />
          </>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {t('help')}
        </Text>
      </Box>
    </Box>
  );
}

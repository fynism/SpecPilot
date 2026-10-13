import { Box, Text, useInput, useStdout } from 'ink';
import { useState } from 'react';
import {
  latestAnswer,
  questionRequest,
  topicStatus,
} from '../../capabilities/clarification/plan.js';
import { isClarificationStopRequest } from '../../capabilities/clarification/policy.js';
import { newId } from '../../capabilities/spec/models.js';
import type { SessionManager } from '../../runtime/session/manager.js';
import { type Locale, translate } from './i18n.js';
import { InputLine } from './input.js';
import { ClarificationOverlay } from './overlays.js';
import { safeTerminalText, terminalLines } from './text.js';

/** 总览只编辑领域草稿；继续按钮才产生一次真实用户提交。 */
export function ClarificationBoard({
  manager,
  locale,
  busy,
  height,
  onClose,
  onRun,
  onChange,
}: {
  manager: SessionManager;
  locale: Locale;
  busy: boolean;
  height: number;
  onClose(): void;
  onRun(query: string): void;
  onChange(): void;
}) {
  const plan = manager.clarification.get();
  const round = plan.rounds.at(-1);
  const [all, setAll] = useState(false);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  const note = plan.draft_note;
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const { stdout } = useStdout();
  const columns = 'columns' in stdout && typeof stdout.columns === 'number' ? stdout.columns : 80;
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);
  const rows = all
    ? plan.topics.flatMap((topic) => [
        { id: topic.id, topic: true, label: topic.title, status: topicStatus(plan, topic.id) },
        ...(!collapsed.includes(topic.id)
          ? plan.questions
              .filter((q) => q.topic_id === topic.id)
              .map((q) => ({ id: q.id, topic: false, label: q.statement, status: q.status }))
          : []),
      ])
    : (round?.question_ids ?? []).flatMap((id) => {
        const q = plan.questions.find((q) => q.id === id);
        return q ? [{ id, topic: false, label: q.statement, status: q.status }] : [];
      });
  const active = rows[Math.min(index, Math.max(0, rows.length - 1))];
  const question =
    active && !active.topic ? plan.questions.find((q) => q.id === active.id) : undefined;
  const attempt = (action: () => void) => {
    try {
      action();
      setError('');
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'UnknownError');
    }
  };
  useInput((input, key) => {
    if (editing || noteMode) return;
    if (key.ctrl || key.meta) {
      if (key.ctrl && input === 'c') onClose();
      return;
    }
    if (history) {
      const total = plan.answers.filter((a) => a.question_id === question?.id).length;
      if (key.escape || input === 'h') setHistory(false);
      else if (key.pageUp) setHistoryPage(Math.max(0, historyPage - 1));
      else if (key.pageDown) setHistoryPage(historyPage + 1);
      else if (key.upArrow) {
        setHistoryIndex(Math.max(0, historyIndex - 1));
        setHistoryPage(0);
      } else if (key.downArrow) {
        setHistoryIndex(Math.min(Math.max(0, total - 1), historyIndex + 1));
        setHistoryPage(0);
      }
      return;
    }
    const count = Math.max(1, height - 12);
    if (key.upArrow) setIndex(Math.max(0, index - 1));
    else if (key.downArrow) setIndex(Math.min(rows.length - 1, index + 1));
    else if (key.pageUp) setIndex(Math.max(0, index - count));
    else if (key.pageDown) setIndex(Math.min(rows.length - 1, index + count));
    else if (key.tab) {
      setAll(!all);
      setIndex(0);
      setHistory(false);
    } else if (key.escape || input === 'b') onClose();
    else if (input === 'h') {
      setHistory(true);
      setHistoryIndex(0);
      setHistoryPage(0);
    } else if (key.return && active?.topic)
      setCollapsed(
        collapsed.includes(active.id)
          ? collapsed.filter((id) => id !== active.id)
          : [...collapsed, active.id],
      );
    else if (!busy) {
      if (key.return && question?.input && question.status !== 'inactive') setEditing(question.id);
      else if (input === 'd' && question)
        attempt(() => manager.deferClarification(question.id, question.status !== 'deferred'));
      else if (input === 'n') setNoteMode(true);
      else if (input === 'c')
        attempt(() => {
          const query = manager.submitClarification(newId('SUBMIT'), note);
          if (query) onRun(query);
        });
      else if (input === 'r') attempt(() => onRun(manager.retryClarification()));
      else if (input === 'x') onRun('/done');
    }
  });
  const editQuestion = plan.questions.find((q) => q.id === editing);
  if (editQuestion?.input && !busy)
    return (
      <ClarificationOverlay
        key={`${editQuestion.id}:${editQuestion.version}`}
        locale={locale}
        maxHeight={height}
        request={questionRequest(editQuestion)}
        initialAnswer={latestAnswer(plan, editQuestion.id)}
        onCancel={() => setEditing(null)}
        onAnswer={(answer) =>
          attempt(() => {
            if (answer.free_text && isClarificationStopRequest(answer.free_text)) {
              setEditing(null);
              onRun('/done');
              return;
            }
            manager.editClarification({
              session_id: manager.current.session_id,
              question_id: editQuestion.id,
              question_version: editQuestion.version,
              answer,
            });
            setEditing(null);
          })
        }
      />
    );
  if (noteMode && !busy)
    return (
      <Box flexDirection="column">
        <Text>{t('board.note')}</Text>
        <InputLine
          initialValue={note}
          onSubmit={(value) =>
            attempt(() => {
              if (isClarificationStopRequest(value)) {
                setNoteMode(false);
                onRun('/done');
                return;
              }
              manager.setClarificationNote(value);
              setNoteMode(false);
            })
          }
          onSpecial={(_value, input, key) => {
            if (key.escape || (key.ctrl && input === 'c')) {
              setNoteMode(false);
              return true;
            }
            return false;
          }}
        />
      </Box>
    );
  const pageSize = Math.max(1, height - 12);
  const page = Math.floor(Math.max(0, index) / pageSize);
  const answers = question ? plan.answers.filter((a) => a.question_id === question.id) : [];
  const resolved = plan.questions.filter((q) => q.status === 'resolved').length;
  if (history) {
    const revision = answers[historyIndex];
    const lines = terminalLines(revision?.answer.free_text ?? '', Math.max(8, columns - 6));
    const size = Math.max(1, height - 6);
    const page = Math.min(historyPage, Math.max(0, Math.ceil(lines.length / size) - 1));
    return (
      <Box flexDirection="column">
        <Text bold>
          {t('board.history')} · {historyIndex + 1}/{Math.max(1, answers.length)}
        </Text>
        <Text wrap="truncate-end">{safeTerminalText(question?.statement ?? '')}</Text>
        {revision ? (
          <>
            <Text>
              {revision.submission_id ? t('board.submitted') : t('board.draft')} ·{' '}
              {revision.created_at}
            </Text>
            <Text wrap="truncate-end">
              {safeTerminalText(revision.answer.selected_option_id ?? '')}
            </Text>
            <Text wrap="truncate-end">
              {lines.slice(page * size, (page + 1) * size).join('\n')}
            </Text>
          </>
        ) : (
          <Text>{t('board.no_history')}</Text>
        )}
        <Text dimColor>{t('board.history_help')}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" overflowY="hidden">
      <Text bold color="cyan" wrap="truncate-end">
        {t('board.title')} · {all ? t('board.all') : t('board.round')} · v{plan.version}
      </Text>
      <Text dimColor wrap="truncate-end">
        {t('board.progress', { resolved, total: plan.questions.length })}
      </Text>
      <Text dimColor wrap="truncate-end">
        {safeTerminalText(round?.summary ?? t('board.empty'))}
      </Text>
      {rows.slice(page * pageSize, (page + 1) * pageSize).map((row, offset) => (
        <Text
          key={row.id}
          bold={row.topic}
          color={page * pageSize + offset === index ? 'cyan' : undefined}
          wrap="truncate-end"
        >
          {page * pageSize + offset === index ? '> ' : '  '}
          {row.topic ? '+ ' : ''}
          {safeTerminalText(row.label)} ·{' '}
          {t(`board.status.${row.status}` as Parameters<typeof translate>[1])}
        </Text>
      ))}
      {!rows.length ? <Text wrap="truncate-end">{t('board.empty')}</Text> : null}
      <Text dimColor>
        {t('board.page', { page: page + 1, total: Math.max(1, Math.ceil(rows.length / pageSize)) })}
      </Text>
      {question ? (
        <Text dimColor wrap="truncate-end">
          {question.blocking ? t('board.blocking') : ''}
          {t('board.dependencies')}: {question.depends_on.join(', ') || '-'} ·{' '}
          {question.open_question_id ?? '-'}
        </Text>
      ) : null}
      {question && latestAnswer(plan, question.id) ? (
        <Text dimColor wrap="truncate-end">
          {t('board.answer')}:{' '}
          {safeTerminalText(latestAnswer(plan, question.id)?.selected_option_id ?? '')}{' '}
          {safeTerminalText(latestAnswer(plan, question.id)?.free_text ?? '')}
        </Text>
      ) : null}
      {note ? (
        <Text dimColor wrap="truncate-end">
          {t('board.note')}: {safeTerminalText(note)}
        </Text>
      ) : null}
      {error ? (
        <Text color="red" wrap="truncate-end">
          {safeTerminalText(error)}
        </Text>
      ) : null}
      <Text color={busy ? 'yellow' : 'cyan'} wrap="truncate-end">
        {busy ? t('board.readonly') : t('board.actions')}
      </Text>
      <Text dimColor wrap="truncate-end">
        {t('board.navigation')}
      </Text>
    </Box>
  );
}

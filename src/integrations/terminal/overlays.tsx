import { type Option, Select } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import {
  answerSchema,
  type ClarificationAnswer,
  type ClarificationRequest,
} from '../../capabilities/clarification/models.js';
import type { SessionRecord } from '../../runtime/session/models.js';
import { type Locale, translate } from './i18n.js';
import { InputLine } from './input.js';
import { safeTerminalText } from './text.js';

/** UI Select 的 defaultValue 不控制光标且重复确认不发事件；用显式按键保证活动项可确认。 */
function SelectionList({
  options,
  initialValue,
  onSelect,
}: {
  options: Option[];
  initialValue?: string;
  onSelect(value: string): void;
}) {
  const [index, setIndex] = useState(
    Math.max(
      0,
      options.findIndex((option) => option.value === initialValue),
    ),
  );
  useInput((_input, key) => {
    if (key.upArrow) setIndex(Math.max(0, index - 1));
    else if (key.downArrow) setIndex(Math.min(options.length - 1, index + 1));
    else if (key.return) {
      const selected = options[index];
      if (selected) onSelect(selected.value);
    }
  });
  return (
    <Select
      key={index}
      isDisabled
      visibleOptionCount={options.length}
      defaultValue={options[index]?.value}
      options={options}
    />
  );
}

export function ClarificationOverlay({
  request,
  locale,
  onAnswer,
  onCancel,
}: {
  request: ClarificationRequest;
  locale: Locale;
  onAnswer(answer: ClarificationAnswer): void;
  onCancel(): void;
}) {
  const recommended = request.options.findIndex((o) => o.id === request.recommended_option_id);
  const [highlight, setHighlight] = useState(recommended);
  const [selected, setSelected] = useState<number | null>(recommended);
  const [error, setError] = useState('');
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string>) =>
    translate(locale, key, values);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{t('clarification.title', { question: safeTerminalText(request.question) })}</Text>
      <Text dimColor>
        {t('clarification.reason', { reason: safeTerminalText(request.reason) })}
      </Text>
      {request.options.map((option, i) => (
        <Box key={option.id} flexDirection="column">
          <Text color={i === highlight ? 'cyan' : undefined}>
            {i === highlight ? '❯' : ' '} {i === selected ? '●' : '○'}{' '}
            {safeTerminalText(option.label)}
            {option.id === request.recommended_option_id ? t('clarification.recommended') : ''}
          </Text>
          <Text dimColor> {safeTerminalText(option.description)}</Text>
        </Box>
      ))}
      <Text dimColor>
        {t('clarification.recommendation', {
          reason: safeTerminalText(request.recommendation_reason),
        })}
      </Text>
      <Text dimColor>{t('clarification.help')}</Text>
      {error ? <Text color="red">{error}</Text> : null}
      <InputLine
        isReadOnly={!request.allow_custom_answer}
        onChange={() => {
          setSelected(null);
          setError('');
        }}
        onSpecial={(_value, input, key) => {
          if (key.escape || (key.ctrl && ['c', 'd'].includes(input))) {
            onCancel();
            return true;
          }
          if (key.upArrow || key.downArrow) {
            const index =
              (highlight + (key.upArrow ? -1 : 1) + request.options.length) %
              request.options.length;
            setHighlight(index);
            setSelected(index);
            return true;
          }
          if (key.tab) {
            setSelected(selected === highlight ? null : highlight);
            return true;
          }
          return false;
        }}
        onSubmit={(value) => {
          const freeText = request.allow_custom_answer ? value.trim() || null : null;
          const choice = selected === null && freeText === null ? highlight : selected;
          const answer = answerSchema.safeParse({
            request_id: request.request_id,
            selected_option_id: choice === null ? null : request.options[choice]?.id,
            free_text: freeText,
          });
          if (answer.success) onAnswer(answer.data);
          else
            setError(
              locale === 'zh-CN'
                ? '回答无效或超过 1000 字符。'
                : 'Invalid answer or more than 1000 characters.',
            );
        }}
      />
    </Box>
  );
}

export function SessionOverlay({
  sessions,
  activeId,
  locale,
  onSelect,
  onCancel,
}: {
  sessions: SessionRecord[];
  activeId: string;
  locale: Locale;
  onSelect(id: string): void;
  onCancel(): void;
}) {
  const [page, setPage] = useState(
    Math.floor(
      Math.max(
        0,
        sessions.findIndex((s) => s.session_id === activeId),
      ) / 10,
    ),
  );
  const total = Math.max(1, Math.ceil(sessions.length / 10));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) onCancel();
    else if (key.pageUp || input === 'p') setPage(Math.max(0, page - 1));
    else if (key.pageDown || input === 'n') setPage(Math.min(total - 1, page + 1));
  });
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        {translate(locale, 'session.title')} ·{' '}
        {translate(locale, 'session.page', { current: page + 1, total })}
      </Text>
      <SelectionList
        key={page}
        initialValue={
          sessions.slice(page * 10, page * 10 + 10).some((s) => s.session_id === activeId)
            ? activeId
            : undefined
        }
        options={sessions.slice(page * 10, page * 10 + 10).map((s) => ({
          value: s.session_id,
          label: `${s.session_id === activeId ? '* ' : ''}${safeTerminalText(s.title)} · ${s.session_id} · ${s.status}`,
        }))}
        onSelect={onSelect}
      />
      <Text dimColor>{translate(locale, 'session.help')}</Text>
    </Box>
  );
}

export function LanguageOverlay({
  locale,
  onSelect,
  onCancel,
}: {
  locale: Locale;
  onSelect(locale: Locale): void;
  onCancel(): void;
}) {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) onCancel();
  });
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{translate(locale, 'language.title')}</Text>
      <SelectionList
        initialValue={locale}
        options={[
          { label: '简体中文', value: 'zh-CN' },
          { label: 'English', value: 'en-US' },
        ]}
        onSelect={(value) => {
          const resolved = value === 'en-US' ? 'en-US' : 'zh-CN';
          onSelect(resolved);
        }}
      />
      <Text dimColor>{translate(locale, 'language.help')}</Text>
    </Box>
  );
}

import { Box, type Key, Text, useInput } from 'ink';
import { useState } from 'react';
import { safeTerminalText } from './text.js';

interface InputProps {
  onSubmit(value: string): void;
  onChange?(value: string): void;
  onSpecial?(value: string, input: string, key: Key): boolean | string;
  isReadOnly?: boolean;
  history?: string[];
}

/** 组合文字编辑与命令/澄清快捷键；UI 的 TextInput 不支持这些共享按键语义。 */
export function InputLine({
  onSubmit,
  onChange,
  onSpecial,
  isReadOnly = false,
  history = [],
}: InputProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const update = (next: string, nextCursor = Array.from(next).length) => {
    setValue(next);
    setCursor(nextCursor);
    onChange?.(next);
  };
  useInput((input, key) => {
    const special = onSpecial?.(value, input, key);
    if (typeof special === 'string') {
      update(special);
      return;
    }
    if (special) return;
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) return;
    const chars = Array.from(value);
    if (key.leftArrow) setCursor(Math.max(0, cursor - 1));
    else if (key.rightArrow) setCursor(Math.min(chars.length, cursor + 1));
    else if (key.home) setCursor(0);
    else if (key.end) setCursor(chars.length);
    else if ((key.upArrow || key.downArrow) && history.length) {
      if (historyIndex === null) setDraft(value);
      const index = Math.max(
        0,
        Math.min(history.length, (historyIndex ?? history.length) + (key.upArrow ? -1 : 1)),
      );
      setHistoryIndex(index);
      update(history[index] ?? draft);
    } else if (!isReadOnly && key.backspace && cursor > 0) {
      chars.splice(cursor - 1, 1);
      update(chars.join(''), cursor - 1);
    } else if (!isReadOnly && key.delete) {
      chars.splice(cursor, 1);
      update(chars.join(''), cursor);
    } else if (!isReadOnly && !key.upArrow && !key.downArrow && input) {
      const inserted = Array.from(safeTerminalText(input, true).replaceAll('\n', ' '));
      chars.splice(cursor, 0, ...inserted);
      update(chars.join(''), cursor + inserted.length);
    }
  });
  const chars = Array.from(value);
  return (
    <Box>
      <Text color="cyan">{'› '}</Text>
      <Text wrap="truncate-end">
        {chars.slice(0, cursor).join('')}
        <Text inverse>{chars[cursor] ?? ' '}</Text>
        {chars.slice(cursor + 1).join('')}
      </Text>
    </Box>
  );
}

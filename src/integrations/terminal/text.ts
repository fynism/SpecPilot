import type { Message } from '../../runtime/model.js';

/** 移除控制序列，持久化内容和模型正文不允许改变终端状态。 */
export function safeTerminalText(text: string, multiline = false): string {
  const cleaned = text.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (c) =>
    multiline && c === '\n' ? '\n' : ' ',
  );
  return multiline ? cleaned : cleaned.replace(/\s+/g, ' ').trim();
}
export interface TranscriptEntry {
  role: Message['role'];
  text: string;
}
/** 按结构化角色提取可读内容，工具协议不混入对话。 */
export function readableTranscript(messages: Message[]): TranscriptEntry[] {
  return messages.flatMap((message) => {
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    return text ? [{ role: message.role, text: safeTerminalText(text, true) }] : [];
  });
}
/** 用保守列宽分行，便于窄终端分页查看完整的问题与历史文字。 */
export function terminalLines(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of safeTerminalText(value).split('\n')) {
    let line = '';
    let columns = 0;
    for (const char of raw) {
      const size = (char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
      if (columns + size > Math.max(8, width)) {
        lines.push(line);
        line = '';
        columns = 0;
      }
      line += char;
      columns += size;
    }
    lines.push(line);
  }
  return lines;
}

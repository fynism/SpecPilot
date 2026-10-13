import type { ContextUsage } from '../../runtime/context/index.js';
import type { Message } from '../../runtime/model.js';
import type { TokenLedger } from '../../runtime/usage.js';
import { type Locale, translate } from './i18n.js';

/** 当前窗口与实际消耗分开显示，缺失的 API 用量不显示为实际零消耗。 */
export function contextUsageText(usage: ContextUsage, locale: Locale): string {
  return translate(
    locale,
    usage.source === 'pending'
      ? 'context.pending'
      : usage.source === 'provider'
        ? 'context.provider'
        : 'context.usage',
    {
      used: usage.usedTokens.toLocaleString(locale),
      window: usage.window.toLocaleString(locale),
      percentage: usage.percentage.toFixed(1),
    },
  );
}
export function tokenConsumptionText(ledger: TokenLedger, locale: Locale): string {
  const total = ledger.total.input_tokens + ledger.total.output_tokens;
  const current = ledger.current_turn.input_tokens + ledger.current_turn.output_tokens;
  const incomplete = ledger.historical_usage_unknown || ledger.total.unreported_requests > 0;
  if (incomplete && !total) return translate(locale, 'usage.unavailable');
  return translate(locale, incomplete ? 'usage.partial' : 'usage.actual', {
    current: current.toLocaleString(locale),
    total: total.toLocaleString(locale),
  });
}

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

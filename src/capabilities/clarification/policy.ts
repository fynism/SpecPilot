import { answerSchema } from './models.js';

const stopRequests = new Set([
  '/done',
  '到此为止',
  '先到这里',
  '暂时到这里',
  '今天先到这里',
  '结束澄清',
  '停止澄清',
  '不用再问了',
  '不需要继续澄清',
]);
const acknowledgements = new Set(['好', '好的', '可以', '嗯', '嗯嗯']);

/** 保守匹配完整短指令，包含结束词的业务句子不能意外终止。 */
export function isClarificationStopRequest(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[，,。.!！?？；;：:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stopRequests.has(normalized)) return true;
  const space = normalized.indexOf(' ');
  return (
    space >= 0 &&
    acknowledgements.has(normalized.slice(0, space)) &&
    stopRequests.has(normalized.slice(space + 1))
  );
}
export class ClarificationStopController {
  requested = false;
  observeAnswer(answer: unknown): void {
    const validated = answerSchema.parse(answer);
    if (validated.free_text !== null && isClarificationStopRequest(validated.free_text))
      this.requested = true;
  }
  consumeRequest(): boolean {
    const requested = this.requested;
    this.requested = false;
    return requested;
  }
}

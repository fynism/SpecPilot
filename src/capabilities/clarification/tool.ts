import type { HookDispatcher } from '../../tooling/contracts.js';
import { newId } from '../spec/models.js';
import {
  answerSchema,
  type ClarificationInput,
  type ClarificationPresenter,
  clarificationInputSchema,
} from './models.js';

export class ClarificationCancelled extends Error {}

/** 澄清回答只产生业务事实；不能成为危险操作的权限批准。 */
export class ClarificationService {
  constructor(
    private readonly presenter: ClarificationPresenter,
    private readonly dispatch: HookDispatcher = () => undefined,
  ) {}
  async request(input: ClarificationInput): Promise<string> {
    const request = { ...clarificationInputSchema.parse(input), request_id: newId('Q') };
    this.dispatch('ClarificationRequested', request);
    let answer: ReturnType<typeof answerSchema.parse>;
    try {
      answer = answerSchema.parse(await this.presenter.ask(request));
    } catch (error) {
      if (!(error instanceof ClarificationCancelled)) throw error;
      this.dispatch('ClarificationCancelled', request);
      return JSON.stringify({ status: 'cancelled', request_id: request.request_id, answer: null });
    }
    // 交互端口也属于输入边界，必须绑定请求和已展示选项，不能信任类型声明。
    if (answer.request_id !== request.request_id) throw new Error('交互界面返回了其他请求的答案');
    if (
      answer.selected_option_id !== null &&
      !request.options.some((o) => o.id === answer.selected_option_id)
    )
      throw new Error('未展示的选项');
    if (answer.free_text !== null && !request.allow_custom_answer)
      throw new Error('当前问题不允许自由输入');
    this.dispatch('ClarificationAnswered', request, answer);
    return JSON.stringify({ status: 'answered', request_id: request.request_id, answer });
  }
}

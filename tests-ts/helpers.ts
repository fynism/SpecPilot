import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionRuntime } from '../src/bootstrap.js';
import type {
  ClarificationInput,
  ClarificationPresenter,
} from '../src/capabilities/clarification/models.js';
import { answerSchema } from '../src/capabilities/clarification/models.js';
import type { SpecToolService } from '../src/capabilities/spec/operations.js';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import type { ModelBlock, ModelClient } from '../src/runtime/model.js';
import { SessionManager } from '../src/runtime/session/manager.js';
import type { ToolSpec } from '../src/tooling/contracts.js';

export const clarification: ClarificationInput = {
  question: '谁可以导出？',
  reason: '权限影响验收',
  options: [
    { id: 'recommended', label: '管理员', description: '遵循最小权限' },
    { id: 'expanded', label: '所有用户', description: '扩大权限范围' },
  ],
  recommended_option_id: 'recommended',
  recommendation_reason: '项目管理员负责数据',
  allow_custom_answer: true,
};
export const recommendedPresenter: ClarificationPresenter = {
  ask: async (request) =>
    answerSchema.parse({
      request_id: request.request_id,
      selected_option_id: request.recommended_option_id,
    }),
};
export function call(id: string, name: string, input: Record<string, unknown> = {}): ModelBlock {
  return { type: 'tool_use', id, name, input };
}
export class ScriptedClient implements ModelClient {
  readonly exposedTools: ToolSpec[][] = [];
  readonly systems: string[] = [];
  private index = 0;
  constructor(private readonly responses: ModelBlock[][]) {}
  async createMessage(
    _messages: unknown,
    tools: ToolSpec[],
    system: string,
  ): Promise<ModelBlock[]> {
    this.exposedTools.push(tools);
    this.systems.push(system);
    const response = this.responses[this.index++];
    if (!response) throw new Error('离线响应耗尽');
    return response;
  }
}
export function temporaryManager(): { root: string; manager: SessionManager; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'specpilot-runtime-'));
  const manager = new SessionManager(new LocalSessionStore(root));
  manager.start();
  return { root, manager, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export function completePatch(service: SpecToolService): Record<string, unknown> {
  return {
    expected_version: service.currentSpec().version,
    change_reason: '保存确认需求',
    operations: [
      { op: 'put_goal', id: 'G-001', statement: '导出数据' },
      {
        op: 'put_requirement',
        id: 'R-001',
        statement: '管理员导出',
        acceptance_criterion_ids: ['AC-001'],
      },
      {
        op: 'put_acceptance_criterion',
        id: 'AC-001',
        statement: '获得文件',
        requirement_ids: ['R-001'],
      },
      {
        op: 'record_evidence',
        id: 'E-001',
        kind: 'clarification',
        summary: '用户确认管理员权限',
        locator: 'clarification:1',
      },
      {
        op: 'record_decision',
        id: 'D-001',
        statement: '管理员导出',
        evidence_ids: ['E-001'],
        rationale: '用户确认',
        made_by: 'user',
      },
    ],
  };
}

/** 旧单题契约的回归适配器；新 CLI 路径单独用默认组合根测试。 */
export function buildLegacySessionRuntime(...args: Parameters<typeof buildSessionRuntime>) {
  return buildSessionRuntime(args[0], args[1], args[2], args[3], args[4], args[5], 'single');
}

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { buildSessionRuntime } from '../src/bootstrap.js';
import { loadSettings } from '../src/config.js';
import { AnthropicModelClient } from '../src/integrations/anthropic/model.js';
import type { ModelClient } from '../src/runtime/model.js';
import { runSessionTurn } from '../src/runtime/turn.js';
import { recommendedPresenter, temporaryManager } from './helpers.js';

it.skipIf(process.env.SPECPILOT_RUN_ENTRY_EVALS !== '1')(
  '真实模型显式入口诊断（合成 fixture，独立付费开关）',
  async () => {
    const settings = loadSettings(resolve('.'));
    const reports: unknown[] = [];
    const directory = resolve('.specpilot/evals');
    mkdirSync(directory, { recursive: true });
    const report = resolve(directory, `clarify-entry-${Date.now()}.json`);
    for (const query of [
      '你好',
      '分析仓库结构',
      '/clarify 你好',
      '/clarify 我想做个管理系统',
      '/clarify 为订单列表增加 CSV 导出功能，用于对账',
    ]) {
      const f = temporaryManager();
      const tools: string[][] = [];
      try {
        cpSync(resolve('evals/fixtures/export_project'), f.root, { recursive: true });
        const transport = new Anthropic({
          apiKey: settings.api_key,
          ...(settings.base_url ? { baseURL: settings.base_url } : {}),
          timeout: 15000,
          maxRetries: 0,
        });
        const inner = new AnthropicModelClient(settings, transport);
        const deadline = Date.now() + 60000;
        const client: ModelClient = {
          get lastUsage() {
            return inner.lastUsage;
          },
          createMessage: async (...args) => {
            if (tools.length >= 8 || Date.now() >= deadline) throw new Error('入口 Eval 达到预算');
            tools.push(args[1].map((t) => t.name));
            return inner.createMessage(...args);
          },
        };
        const before = f.manager.current;
        const result = await runSessionTurn(
          f.manager,
          buildSessionRuntime(
            f.manager,
            f.root,
            { ...settings, max_tool_use_turns: 5 },
            recommendedPresenter,
            () => undefined,
            client,
          ),
          query,
        );
        if (query.includes('订单列表')) {
          expect(tools[0]).toEqual([]);
          expect(
            tools.slice(1).some((names) => names.includes('publish_clarification_round')),
          ).toBe(true);
          expect([
            'clarification_round_ready',
            'clarification_completed',
            'clarification_incomplete',
          ]).toContain(result);
        } else {
          expect(tools.flat()).not.toContain('publish_clarification_round');
          expect(tools.flat()).not.toContain('apply_spec_patch');
          expect(f.manager.current.spec_versions).toEqual(before.spec_versions);
          expect(f.manager.clarification.get()).toEqual(before.clarification_plan);
        }
      } finally {
        reports.push({
          query,
          tools,
          usage: f.manager.current.token_usage,
          spec: f.manager.currentSpec(),
          plan: f.manager.clarification.get(),
        });
        writeFileSync(
          report,
          JSON.stringify({ rubric: 'evals/clarify-entry.md', reports }, null, 2),
        );
        f.cleanup();
      }
    }
  },
  240000,
);

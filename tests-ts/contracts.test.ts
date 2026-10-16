import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSpecification, specificationSchema } from '../src/capabilities/spec/models.js';
import { loadSettings } from '../src/config.js';
import { FINAL_RESPONSE_SYSTEM_SUFFIX, ROUND_SYSTEM, SYSTEM } from '../src/runtime/prompts.js';
import { sessionSchema } from '../src/runtime/session/models.js';

describe('严格契约与兼容配置', () => {
  it('提示词包含精简 Spec 和持续追问边界', () => {
    expect(SYSTEM).toContain('Ask one pivotal question');
    expect(SYSTEM).toContain('Never turn a recommendation into a user decision');
    expect(ROUND_SYSTEM).toContain('depends_on');
    expect(FINAL_RESPONSE_SYSTEM_SUFFIX).toContain('No tools are available');
  });
  it('旧 Session 格式不再自动迁移，当前格式严格校验', () => {
    const original = JSON.parse(
      readFileSync(new URL('./fixtures/python-session-v1.json', import.meta.url), 'utf8'),
    );
    expect(() => sessionSchema.parse(original)).toThrow();
    expect(() => sessionSchema.parse({ ...original, schema_version: 4 })).toThrow();
  });
  it('保留版本、ID 和 JSON 时间，拒绝额外字段及类型转换', () => {
    const spec = createSpecification('需求', '2026-09-15T00:00:00+00:00');
    expect(specificationSchema.parse(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
    expect(() => specificationSchema.parse({ ...spec, version: '1' })).toThrow();
    expect(() => specificationSchema.parse({ ...spec, surprise: 1 })).toThrow();
  });
  it('用户决策必须引用用户证据，验收示例归属于需求', () => {
    const spec = createSpecification('需求');
    expect(() =>
      specificationSchema.parse({
        ...spec,
        decisions: [
          {
            id: 'D-001',
            statement: '已确认',
            rationale: '理由',
            made_by: 'user',
            decided_at: spec.created_at,
          },
        ],
      }),
    ).toThrow('用户决策');
    expect(
      specificationSchema.parse({
        ...spec,
        goal: { id: 'G-001', statement: '导出记录', evidence_ids: [], lifecycle: 'active' },
        requirements: [
          {
            id: 'R-001',
            statement: '管理员可导出',
            evidence_ids: [],
            lifecycle: 'active',
            acceptance_examples: ['获得 CSV 文件'],
          },
        ],
      }).requirements[0]?.acceptance_examples,
    ).toEqual(['获得 CSV 文件']);
  });
  it('工作区 .env 优先，整数预算严格校验，错误不泄漏密钥', () => {
    const root = mkdtempSync(join(tmpdir(), 'specpilot-config-'));
    try {
      writeFileSync(join(root, '.env'), 'MODEL_ID=file-model\nMAX_TOOL_USE_TURNS=3\n');
      expect(
        loadSettings(root, { ANTHROPIC_API_KEY: 'test-secret', MODEL_ID: 'env-model' }).model,
      ).toBe('file-model');
      writeFileSync(join(root, '.env'), 'MAX_TOOL_USE_TURNS=2.5\n');
      expect(() => loadSettings(root, {})).toThrow('必须是整数');
      writeFileSync(join(root, '.env'), 'MAX_TOOL_USE_TURNS=0\n');
      expect(() => loadSettings(root, { ANTHROPIC_API_KEY: 'test-secret' })).toThrow();
      rmSync(join(root, '.env'));
      expect(() => loadSettings(root, {})).toThrow('缺少 ANTHROPIC_API_KEY');
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

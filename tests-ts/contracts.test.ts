import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSpecification, specificationSchema } from '../src/capabilities/spec/models.js';
import { loadSettings } from '../src/config.js';
import { FINAL_RESPONSE_SYSTEM_SUFFIX, SYSTEM } from '../src/runtime/prompts.js';
import { sessionSchema } from '../src/runtime/session/models.js';

describe('严格契约与兼容配置', () => {
  it('模型角色与工具边界提示逐字保留原 Python 版本', () => {
    const prompts = JSON.parse(
      readFileSync(new URL('./fixtures/python-prompts.json', import.meta.url), 'utf8'),
    );
    expect({ SYSTEM, FINAL_RESPONSE_SYSTEM_SUFFIX }).toEqual(prompts);
  });
  it('读取真实 Python 序列化的 Session 与连续 Spec 历史', () => {
    const original = JSON.parse(
      readFileSync(new URL('./fixtures/python-session-v1.json', import.meta.url), 'utf8'),
    );
    const migrated = sessionSchema.parse(original);
    expect(migrated).toEqual({
      ...original,
      schema_version: 2,
      context: { summary: '', through: 0, compactions: [] },
    });
    expect(sessionSchema.parse(migrated)).toEqual(migrated);
    expect(() => sessionSchema.parse({ ...original, schema_version: 3 })).toThrow();
    expect(() => sessionSchema.parse({ ...original, status: 'running' })).toThrow();
    expect(() =>
      sessionSchema.parse({ ...original, spec_versions: [...original.spec_versions].reverse() }),
    ).toThrow();
  });
  it('保留版本、ID 和 JSON 时间，拒绝额外字段及类型转换', () => {
    const spec = createSpecification('需求', '2026-09-15T00:00:00+00:00');
    expect(specificationSchema.parse(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
    expect(() => specificationSchema.parse({ ...spec, version: '1' })).toThrow();
    expect(() => specificationSchema.parse({ ...spec, surprise: 1 })).toThrow();
  });
  it('用户决策必须引用用户证据，BDD 场景必须完整', () => {
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
    expect(() =>
      specificationSchema.parse({
        ...spec,
        acceptance_criteria: [
          { id: 'AC-001', statement: '可验收', requirement_ids: ['R-001'], given: '前提' },
        ],
      }),
    ).toThrow();
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

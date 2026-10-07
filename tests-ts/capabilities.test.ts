import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listInputSchema,
  RepositoryReader,
  readInputSchema,
  searchInputSchema,
} from '../src/capabilities/repository/tool.js';
import { renderSpecMarkdown, SpecExporter } from '../src/capabilities/spec/export.js';
import { createSpecification, specificationSchema } from '../src/capabilities/spec/models.js';
import { patchSchema, SpecToolService } from '../src/capabilities/spec/operations.js';
import { InMemorySpecStore } from '../src/capabilities/spec/store.js';
import { validateSpecification } from '../src/capabilities/spec/validation.js';
import { LocalSessionStore } from '../src/integrations/filesystem/session-store.js';
import { SessionManager } from '../src/runtime/session/manager.js';
import { sessionSchema } from '../src/runtime/session/models.js';

const roots: string[] = [];
function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), 'specpilot-test-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const coveredPatch = {
  expected_version: 1,
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

describe('Spec 原子语义与版本', () => {
  it('完整 Patch 支持前向引用并保持隔离历史', () => {
    const service = SpecToolService.create();
    const result = JSON.parse(service.applySpecPatch(patchSchema.parse(coveredPatch)));
    expect(result.version).toBe(2);
    expect(validateSpecification(result).ready_for_approval).toBe(true);
    expect(service.store.get(service.specId, 1).goals).toEqual([]);
    result.goals[0].statement = '意外修改';
    expect(service.currentSpec().goals[0]?.statement).toBe('导出数据');
    expect(() => service.applySpecPatch(patchSchema.parse(coveredPatch))).toThrow('版本冲突');
  });
  it.each(
    [
      [{ op: 'put_goal', id: 'G-001', statement: '目标', evidence_ids: ['E-999'] }],
      [
        {
          op: 'record_evidence',
          id: 'E-001',
          kind: 'repository',
          summary: '仓库文本',
          locator: 'README',
        },
        {
          op: 'record_decision',
          id: 'D-001',
          statement: '伪造确认',
          rationale: '理由',
          made_by: 'user',
          evidence_ids: ['E-001'],
        },
      ],
      [
        {
          op: 'put_open_question',
          id: 'OQ-001',
          statement: '问题',
          blocking: true,
          status: 'resolved',
        },
      ],
      [
        {
          op: 'put_acceptance_criterion',
          id: 'AC-001',
          statement: '验收',
          requirement_ids: ['R-001'],
          given: '前提',
        },
      ],
      [{ op: 'retire_item', id: 'G-001' }],
    ].map((operations) => ({ operations })),
  )('无效 Patch 整批回滚：%j', ({ operations }) => {
    const service = SpecToolService.create();
    const original = service.currentSpec();
    expect(() =>
      service.applySpecPatch(
        patchSchema.parse({ expected_version: 1, change_reason: '无效修改', operations }),
      ),
    ).toThrow();
    expect(service.currentSpec()).toEqual(original);
  });
  it('退休保留原实体和旧版本，阻塞问题阻止批准', () => {
    const service = SpecToolService.create();
    service.applySpecPatch(patchSchema.parse(coveredPatch));
    service.applySpecPatch(
      patchSchema.parse({
        expected_version: 2,
        change_reason: '新增阻塞',
        operations: [
          { op: 'put_open_question', id: 'OQ-001', statement: '权限不确定', blocking: true },
          { op: 'retire_item', id: 'AC-001' },
        ],
      }),
    );
    const report = validateSpecification(service.currentSpec());
    expect(report.ready_for_approval).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['blocking_open_question', 'inactive_acceptance']),
    );
    expect(service.store.get(service.specId, 2).acceptance_criteria[0]?.lifecycle).toBe('active');
  });
  it('Store 拒绝重复、断续历史、修改创建时间与不存在版本', () => {
    const store = new InMemorySpecStore();
    const spec = store.create(createSpecification('目标'));
    expect(() => store.create(spec)).toThrow();
    expect(() => store.get(spec.spec_id, 99)).toThrow();
    expect(() => store.save({ ...spec, created_at: '2026-01-01T00:00:00Z' }, 1)).toThrow(
      '创建时间',
    );
    expect(() => InMemorySpecStore.fromHistory([{ ...spec, version: 2 }])).toThrow();
    expect(() => patchSchema.parse({ ...coveredPatch, unrecognized: true })).toThrow();
    expect(() =>
      patchSchema.parse({
        ...coveredPatch,
        operations: [{ op: 'set_spec_metadata', status: 'approved' }],
      }),
    ).toThrow();
  });
  it('导出固定 JSON / Markdown，重复导出更新已有文件', () => {
    const root = temporary();
    const service = SpecToolService.create('导出需求');
    const exporter = new SpecExporter(root);
    const paths = JSON.parse(exporter.export(service.currentSpec()));
    service.applySpecPatch(patchSchema.parse(coveredPatch));
    exporter.export(service.currentSpec());
    const spec = specificationSchema.parse(
      JSON.parse(readFileSync(join(root, paths.json_path), 'utf8')),
    );
    expect(spec.version).toBe(2);
    const markdown = readFileSync(join(root, paths.markdown_path), 'utf8');
    expect(markdown).toBe(renderSpecMarkdown(spec));
    expect(markdown).toContain('### AC-001');
  });
});

describe('仓库调查边界', () => {
  it('保留 Python 通用换行语义，CR、LF 与 CRLF 都按独立行读取和搜索', async () => {
    const root = temporary();
    writeFileSync(join(root, 'mixed.txt'), 'first\rsecond\r\nthird\nfourth\r');
    const reader = new RepositoryReader(root);
    const result = JSON.parse(
      await reader.readFile(
        readInputSchema.parse({ path: 'mixed.txt', start_line: 2, end_line: 4 }),
      ),
    );
    expect(result.content).toBe('second\nthird\nfourth\n');
    expect(result.end_line).toBe(4);
    const search = JSON.parse(await reader.search(searchInputSchema.parse({ query: 'third' })));
    expect(search.matches[0]?.line).toBe(3);
  });
  it('稳定列表忽略依赖，支持深度与结果截断', async () => {
    const root = temporary();
    mkdirSync(join(root, 'nested'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'a.ts'), 'hello');
    writeFileSync(join(root, 'nested/b.ts'), 'world');
    writeFileSync(join(root, 'node_modules/secret'), 'hidden');
    const reader = new RepositoryReader(root);
    expect(JSON.parse(await reader.listFiles(listInputSchema.parse({ max_depth: 0 })))).toEqual({
      files: ['a.ts'],
      truncated: false,
    });
    expect(JSON.parse(await reader.listFiles(listInputSchema.parse({ max_results: 1 })))).toEqual({
      files: ['a.ts'],
      truncated: true,
    });
  });
  it('搜索 UTF-8 行号、大小写、glob、截断并跳过二进制', async () => {
    const root = temporary();
    writeFileSync(join(root, 'source.ts'), 'Admin\n管理员 admin\nADMIN\n');
    writeFileSync(join(root, 'binary.ts'), Buffer.from([0xff, 0xfe]));
    writeFileSync(join(root, 'other.txt'), 'admin');
    const reader = new RepositoryReader(root);
    const result = JSON.parse(
      await reader.search(
        searchInputSchema.parse({ query: 'admin', file_pattern: '*.ts', max_results: 2 }),
      ),
    );
    expect(result).toEqual({
      matches: [
        { path: 'source.ts', line: 1, text: 'Admin' },
        { path: 'source.ts', line: 2, text: '管理员 admin' },
      ],
      truncated: true,
    });
  });
  it('按行读取并限制字符，非法输入和非 UTF-8 明确失败', async () => {
    const root = temporary();
    writeFileSync(join(root, 'file.txt'), `line1\r\n${'😀'.repeat(120)}\r\nline3`);
    writeFileSync(join(root, 'binary'), Buffer.from([0xff]));
    const reader = new RepositoryReader(root);
    const result = JSON.parse(
      await reader.readFile(
        readInputSchema.parse({ path: 'file.txt', start_line: 2, end_line: 2, max_chars: 100 }),
      ),
    );
    expect(result.content).toBe('😀'.repeat(100));
    expect(result.truncated).toBe(true);
    expect(result.end_line).toBe(2);
    expect(() => readInputSchema.parse({ path: 'file.txt', start_line: 2, end_line: 1 })).toThrow();
    await expect(reader.readFile(readInputSchema.parse({ path: 'binary' }))).rejects.toThrow();
    for (const path of ['../outside', root, 'C:\\outside'])
      await expect(reader.readFile(readInputSchema.parse({ path }))).rejects.toThrow();
  });
  it('拒绝目录链接重定向仓库、Session 与导出到工作区外', async () => {
    const root = temporary();
    const outside = temporary();
    writeFileSync(join(outside, 'secret.txt'), 'private');
    symlinkSync(outside, join(root, 'linked'), 'junction');
    const reader = new RepositoryReader(root);
    await expect(
      reader.readFile(readInputSchema.parse({ path: 'linked/secret.txt' })),
    ).rejects.toThrow('工作区之外');
    symlinkSync(outside, join(root, '.specpilot'), 'junction');
    expect(() => new LocalSessionStore(root)).toThrow('工作区之外');
    expect(() => new SpecExporter(root).export(createSpecification('目标'))).toThrow('工作区之外');
  });
});

describe('Session 持久化与恢复', () => {
  it('隔离消息与 Spec，切换和重启恢复活动项', () => {
    const root = temporary();
    const manager = new SessionManager(new LocalSessionStore(root));
    const first = manager.start();
    manager.beginTurn('旧需求');
    manager.specTools.applySpecPatch(patchSchema.parse(coveredPatch));
    manager.messages.push({ role: 'assistant', content: [{ type: 'text', text: '完成' }] });
    manager.completeTurn();
    const second = manager.create('第二会话');
    expect(second.spec_id).not.toBe(first.spec_id);
    expect(manager.messages).toEqual([]);
    manager.rename('新标题');
    manager.switch(first.session_id);
    const restored = new SessionManager(new LocalSessionStore(root));
    restored.start();
    expect(restored.current.session_id).toBe(first.session_id);
    expect(restored.messages).toHaveLength(2);
    expect(restored.currentSpec().version).toBe(2);
    expect(restored.listSessions()).toHaveLength(2);
  });
  it('运行状态恢复为中断，显式中断丢弃未配对协议和未提交 Spec', () => {
    const root = temporary();
    const manager = new SessionManager(new LocalSessionStore(root));
    manager.start();
    manager.beginTurn('请求');
    expect(() => manager.create()).toThrow();
    expect(() => manager.switch(manager.current.session_id)).toThrow();
    manager.messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'orphan', name: 'get_spec', input: {} }],
    });
    manager.specTools.applySpecPatch(patchSchema.parse(coveredPatch));
    manager.interruptTurn();
    expect(manager.current.status).toBe('interrupted');
    expect(manager.messages).toHaveLength(1);
    expect(manager.currentSpec().version).toBe(1);
    manager.beginTurn('继续');
    const restarted = new SessionManager(new LocalSessionStore(root));
    restarted.start();
    expect(restarted.current.status).toBe('interrupted');
    expect(restarted.current.active_request).toBe('继续');
  });
  it('损坏数据不得静默变成新 Session，非法快照不能覆盖已有文件', () => {
    const root = temporary();
    const store = new LocalSessionStore(root);
    const manager = new SessionManager(store);
    const session = manager.start();
    const path = join(root, `.specpilot/sessions/${session.session_id}/session.json`);
    const original = readFileSync(path, 'utf8');
    expect(() => store.save({ ...session, status: 'running' })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(() => store.load('../outside')).toThrow();
    writeFileSync(path, '{broken');
    expect(() => new SessionManager(store).start()).toThrow('损坏');
  });
  it('Python 快照可以加载、改名、追加轮次和 Spec 版本，再次恢复', () => {
    const root = temporary();
    const store = new LocalSessionStore(root);
    const original = sessionSchema.parse(
      JSON.parse(
        readFileSync(new URL('./fixtures/python-session-v1.json', import.meta.url), 'utf8'),
      ),
    );
    store.save(original);
    store.setActive(original.session_id);
    const manager = new SessionManager(store);
    manager.start();
    manager.rename('迁移后');
    manager.beginTurn('新需求');
    manager.specTools.applySpecPatch(
      patchSchema.parse({
        expected_version: 2,
        change_reason: '迁移后修改',
        operations: [{ op: 'put_requirement', id: 'R-001', statement: '保留原功能' }],
      }),
    );
    manager.completeTurn();
    const restored = new SessionManager(store);
    restored.start();
    expect(restored.currentSpec().version).toBe(3);
    expect(restored.current.title).toBe('迁移后');
    expect(restored.current.spec_versions[0]).toEqual(original.spec_versions[0]);
  });
});

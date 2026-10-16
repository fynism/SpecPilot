import { relative } from 'node:path';
import { atomicWrite, boundedPath, workspaceRoot } from '../../integrations/filesystem/paths.js';
import { type Specification, specificationSchema } from './models.js';

/** Markdown 是结构化事实源的确定性投影，不参与需求状态修改。 */
export function renderSpecMarkdown(spec: Specification): string {
  const lines = [
    `# ${spec.title}`,
    '',
    `- Spec ID：\`${spec.spec_id}\``,
    `- 版本：${spec.version}`,
    `- 状态：\`${spec.status}\``,
    `- 本版原因：${spec.change_reason}`,
    '',
    '## 需求',
    '',
  ];
  if (spec.goal?.lifecycle === 'active') lines.push(spec.goal.statement, '');
  const requirements = spec.requirements.filter((r) => r.lifecycle === 'active');
  for (const r of requirements) lines.push(`- **${r.id}**：${r.statement}`);
  const boundaries = spec.boundaries.filter((b) => b.lifecycle === 'active');
  if (boundaries.length) {
    const labels = { in_scope: '包含', out_of_scope: '不包含', constraint: '约束' };
    lines.push('', '## 边界与约束', '');
    for (const b of boundaries)
      lines.push(`- **${b.id}**（${labels[b.disposition]}）：${b.statement}`);
  }
  const decisions = spec.decisions.filter((d) => d.lifecycle === 'active');
  if (decisions.length) {
    lines.push('', '## 产品决策', '');
    for (const d of decisions)
      lines.push(`- **${d.id}**：${d.statement}`, `  - 理由与取舍：${d.rationale}`);
  }
  if (requirements.some((r) => r.acceptance_examples.length)) {
    lines.push('', '## 验收示例', '');
    for (const r of requirements) {
      if (!r.acceptance_examples.length) continue;
      lines.push(`### ${r.id} — ${r.statement}`, '');
      for (const example of r.acceptance_examples) lines.push(`- ${example}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
export class SpecExporter {
  private readonly root: string;
  constructor(workspace: string) {
    this.root = workspaceRoot(workspace);
  }
  export(input: Specification): string {
    const spec = specificationSchema.parse(input);
    const directory = boundedPath(this.root, `.specpilot/specs/${spec.spec_id}`);
    const json = boundedPath(this.root, `${directory}/spec.json`);
    const markdown = boundedPath(this.root, `${directory}/SPEC.md`);
    atomicWrite(this.root, json, `${JSON.stringify(spec, null, 2)}\n`);
    atomicWrite(this.root, markdown, renderSpecMarkdown(spec));
    return JSON.stringify({
      spec_id: spec.spec_id,
      version: spec.version,
      json_path: relative(this.root, json).replaceAll('\\', '/'),
      markdown_path: relative(this.root, markdown).replaceAll('\\', '/'),
    });
  }
}

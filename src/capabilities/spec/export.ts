import { relative } from 'node:path';
import { atomicWrite, boundedPath, workspaceRoot } from '../../integrations/filesystem/paths.js';
import { entityFields, type Specification, specificationSchema } from './models.js';

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
  ];
  const labels = ['目标', '范围', '需求', '决策', '假设', '未决问题'];
  const suffix = (lifecycle: string) => (lifecycle === 'retired' ? '（已停用）' : '');
  for (const [i, field] of entityFields.slice(0, 6).entries()) {
    lines.push(`## ${labels[i]}`, '');
    if (!spec[field].length) lines.push('_暂无。_', '');
    for (const item of spec[field]) {
      lines.push(`- **${item.id}**${suffix(item.lifecycle)}：${item.statement}`);
      if (item.evidence_ids.length) lines.push(`  - 证据：${item.evidence_ids.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('## 验收条件', '');
  if (!spec.acceptance_criteria.length) lines.push('_暂无。_', '');
  for (const ac of spec.acceptance_criteria) {
    lines.push(
      `### ${ac.id}${suffix(ac.lifecycle)} — ${ac.statement}`,
      '',
      `关联需求：${ac.requirement_ids.join(', ')}`,
      '',
    );
    if (ac.given !== null)
      lines.push(`- Given：${ac.given}`, `- When：${ac.when}`, `- Then：${ac.then}`, '');
  }
  lines.push('## 证据', '');
  if (!spec.evidence.length) lines.push('_暂无。_', '');
  for (const e of spec.evidence)
    lines.push(`- **${e.id}** \`${e.kind}\`：${e.summary}`, `  - 来源：${e.locator}`);
  return `${lines.join('\n')}\n`;
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

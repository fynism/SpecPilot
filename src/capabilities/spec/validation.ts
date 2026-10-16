import type { Specification } from './models.js';

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  entity_id: string | null;
}
/** 只检查可验证的完整性；关键问题识别质量仍需要行为 Eval。 */
export function validateSpecification(spec: Specification): {
  spec_id: string;
  version: number;
  ready_for_approval: boolean;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const add = (code: string, message: string, entity_id: string | null = null) =>
    issues.push({ code, message, entity_id, severity: 'error' });
  if (!spec.goal || spec.goal.lifecycle !== 'active')
    add('missing_goal', 'Spec 需要一个明确有效的目标。');
  const requirements = spec.requirements.filter((r) => r.lifecycle === 'active');
  if (!requirements.length) add('missing_requirement', 'Spec 至少需要一条有效需求。');
  for (const r of requirements)
    if (!r.acceptance_examples.length)
      add('requirement_without_acceptance', '需求缺少可验证的验收示例。', r.id);
  return {
    spec_id: spec.spec_id,
    version: spec.version,
    ready_for_approval: !issues.length,
    issues,
  };
}

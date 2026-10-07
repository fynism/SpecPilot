import type { Specification } from './models.js';

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  entity_id: string | null;
}

/** 确定性验证可批准性；只报告事实，不自动批准用户需求。 */
export function validateSpecification(spec: Specification): {
  spec_id: string;
  version: number;
  ready_for_approval: boolean;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const add = (
    code: string,
    message: string,
    entity_id: string | null = null,
    severity: 'error' | 'warning' = 'error',
  ) => {
    issues.push({ code, message, entity_id, severity });
  };
  const requirements = spec.requirements.filter((r) => r.lifecycle === 'active');
  const criteria = spec.acceptance_criteria.filter((ac) => ac.lifecycle === 'active');
  if (!spec.goals.some((g) => g.lifecycle === 'active'))
    add('missing_goal', 'Spec 至少需要一个有效 Goal。');
  if (!requirements.length) add('missing_requirement', 'Spec 至少需要一个有效 Requirement。');
  for (const q of spec.open_questions)
    if (q.lifecycle === 'active' && q.status === 'open') {
      add(
        q.blocking ? 'blocking_open_question' : 'open_question',
        '仍有 OpenQuestion 未解决。',
        q.id,
        q.blocking ? 'error' : 'warning',
      );
    }
  for (const r of requirements) {
    if (!r.acceptance_criterion_ids.length)
      add('requirement_without_acceptance', 'Requirement 没有对应验收条件。', r.id);
    for (const ref of new Set(r.acceptance_criterion_ids)) {
      const ac = criteria.find((c) => c.id === ref);
      if (!ac) add('inactive_acceptance', 'Requirement 引用的验收条件已停用。', r.id);
      else if (!ac.requirement_ids.includes(r.id))
        add('asymmetric_acceptance_link', '需求与验收关联必须双向一致。', r.id);
    }
  }
  for (const ac of criteria)
    for (const ref of ac.requirement_ids) {
      const r = requirements.find((item) => item.id === ref);
      if (!r) add('inactive_requirement', '验收条件引用的 Requirement 已停用。', ac.id);
      else if (!r.acceptance_criterion_ids.includes(ac.id))
        add('asymmetric_requirement_link', '验收与需求关联必须双向一致。', ac.id);
    }
  for (const a of spec.assumptions)
    if (a.lifecycle === 'active')
      add('active_assumption', 'Spec 仍包含尚未确认的假设。', a.id, 'warning');
  return {
    spec_id: spec.spec_id,
    version: spec.version,
    ready_for_approval: !issues.some((i) => i.severity === 'error'),
    issues,
  };
}

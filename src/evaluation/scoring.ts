import { readFileSync } from 'node:fs';
import { z } from 'zod';

const expectationSchema = z.strictObject({
  required_tools: z.array(z.string()).default([]),
  forbidden_tools: z.array(z.string()).default([]),
  min_clarifications: z.number().int().min(0).default(0),
  max_clarifications: z.number().int().min(0).default(0),
  required_spec_entities: z.array(z.string()).default([]),
});
const caseSchema = z.strictObject({
  id: z.string(),
  category: z.string(),
  user_input: z.string(),
  fixture: z.string(),
  scoring: z.literal('deterministic_trace_v1'),
  expectation: expectationSchema,
});
export type EvalCase = z.infer<typeof caseSchema>;
export interface AgentTrace {
  tools: string[];
  clarification_count: number;
  spec_entities: string[];
}
export function loadEvalCases(path: string): EvalCase[] {
  return z.array(caseSchema).parse(JSON.parse(readFileSync(path, 'utf8')));
}
/** 保留四项确定性评分，严重禁止行为不能被平均分掩盖。 */
export function scoreTrace(
  scenario: EvalCase,
  trace: AgentTrace,
): { passed: boolean; checks_passed: number; checks_total: number; violations: string[] } {
  const e = scenario.expectation;
  const violations: string[] = [];
  const missing = e.required_tools.filter((t) => !trace.tools.includes(t));
  const forbidden = e.forbidden_tools.filter((t) => trace.tools.includes(t));
  const entities = e.required_spec_entities.filter((t) => !trace.spec_entities.includes(t));
  if (missing.length) violations.push(`缺少必要工具：${missing.sort().join(', ')}`);
  if (forbidden.length) violations.push(`调用禁止工具：${forbidden.sort().join(', ')}`);
  if (
    trace.clarification_count < e.min_clarifications ||
    trace.clarification_count > e.max_clarifications
  )
    violations.push('澄清次数不在允许范围内');
  if (entities.length) violations.push(`缺少 Spec 实体：${entities.sort().join(', ')}`);
  return {
    passed: !violations.length,
    checks_passed: 4 - violations.length,
    checks_total: 4,
    violations,
  };
}

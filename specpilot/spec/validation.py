"""对 Specification 执行确定性的完整性与可批准性检查。"""

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict

from specpilot.spec.models import Specification


class SpecValidationIssue(BaseModel):
    """一条机器可识别、同时可供用户阅读的验证问题。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    code: str
    severity: Literal["error", "warning"]
    message: str
    entity_id: str | None = None


class SpecValidationReport(BaseModel):
    """当前 Spec 是否具备进入人工批准阶段的确定性结论。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    spec_id: str
    version: int
    ready_for_approval: bool
    issues: tuple[SpecValidationIssue, ...]

    def to_json(self) -> str:
        """生成供模型读取的紧凑 JSON。"""

        return self.model_dump_json()


def validate_specification(spec: Specification) -> SpecValidationReport:
    """检查目标、阻塞问题和需求—验收条件覆盖关系。"""

    issues: list[SpecValidationIssue] = []
    active_goals = [item for item in spec.goals if item.lifecycle == "active"]
    active_requirements = [item for item in spec.requirements if item.lifecycle == "active"]
    active_criteria = {
        item.id: item for item in spec.acceptance_criteria if item.lifecycle == "active"
    }
    active_requirement_ids = {item.id for item in active_requirements}

    if not active_goals:
        issues.append(
            SpecValidationIssue(
                code="missing_goal",
                severity="error",
                message="Spec 至少需要一个有效 Goal。",
            )
        )
    if not active_requirements:
        issues.append(
            SpecValidationIssue(
                code="missing_requirement",
                severity="error",
                message="Spec 至少需要一个有效 Requirement。",
            )
        )

    for question in spec.open_questions:
        if question.lifecycle != "active" or question.status != "open":
            continue
        issues.append(
            SpecValidationIssue(
                code="blocking_open_question" if question.blocking else "open_question",
                severity="error" if question.blocking else "warning",
                message=(
                    "仍有阻塞性 OpenQuestion 未解决。"
                    if question.blocking
                    else "仍有非阻塞 OpenQuestion 未解决。"
                ),
                entity_id=question.id,
            )
        )

    for requirement in active_requirements:
        linked_ids = set(requirement.acceptance_criterion_ids)
        if not linked_ids:
            issues.append(
                SpecValidationIssue(
                    code="requirement_without_acceptance",
                    severity="error",
                    message="Requirement 没有对应的 AcceptanceCriterion。",
                    entity_id=requirement.id,
                )
            )
            continue
        for criterion_id in linked_ids:
            criterion = active_criteria.get(criterion_id)
            if criterion is None:
                issues.append(
                    SpecValidationIssue(
                        code="inactive_acceptance",
                        severity="error",
                        message="Requirement 引用的验收条件已停用。",
                        entity_id=requirement.id,
                    )
                )
            elif requirement.id not in criterion.requirement_ids:
                issues.append(
                    SpecValidationIssue(
                        code="asymmetric_acceptance_link",
                        severity="error",
                        message="Requirement 与 AcceptanceCriterion 的关联必须双向一致。",
                        entity_id=requirement.id,
                    )
                )

    for criterion in active_criteria.values():
        for requirement_id in criterion.requirement_ids:
            if requirement_id not in active_requirement_ids:
                issues.append(
                    SpecValidationIssue(
                        code="inactive_requirement",
                        severity="error",
                        message="验收条件引用的 Requirement 已停用。",
                        entity_id=criterion.id,
                    )
                )
                continue
            requirement = next(item for item in active_requirements if item.id == requirement_id)
            if criterion.id not in requirement.acceptance_criterion_ids:
                issues.append(
                    SpecValidationIssue(
                        code="asymmetric_requirement_link",
                        severity="error",
                        message="AcceptanceCriterion 与 Requirement 的关联必须双向一致。",
                        entity_id=criterion.id,
                    )
                )

    for assumption in spec.assumptions:
        if assumption.lifecycle == "active":
            issues.append(
                SpecValidationIssue(
                    code="active_assumption",
                    severity="warning",
                    message="Spec 仍包含尚未由用户确认的 Assumption。",
                    entity_id=assumption.id,
                )
            )

    has_errors = any(issue.severity == "error" for issue in issues)
    return SpecValidationReport(
        spec_id=spec.spec_id,
        version=spec.version,
        ready_for_approval=not has_errors,
        issues=tuple(issues),
    )


def report_as_json(spec: Specification) -> str:
    """兼容 Tool Handler 的单参数 JSON 返回函数。"""

    return json.dumps(
        validate_specification(spec).model_dump(mode="json"),
        ensure_ascii=False,
        separators=(",", ":"),
    )

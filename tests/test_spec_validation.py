"""Specification 确定性验证规则的行为测试。"""

from datetime import UTC, datetime

from specpilot.capabilities.spec.models import (
    AcceptanceCriterion,
    Goal,
    OpenQuestion,
    Requirement,
    Specification,
    create_specification,
)
from specpilot.capabilities.spec.validation import validate_specification

NOW = datetime(2026, 9, 5, 8, 0, tzinfo=UTC)


def build_valid_spec() -> Specification:
    """构造满足最小批准条件的 Spec。"""

    original = create_specification("数据导出", now=NOW)
    requirement = Requirement(
        id="R-001",
        statement="管理员可以导出",
        acceptance_criterion_ids=("AC-001",),
    )
    criterion = AcceptanceCriterion(
        id="AC-001",
        statement="管理员获得导出文件",
        requirement_ids=("R-001",),
    )
    payload = original.model_dump()
    payload.update(
        {
            "goals": (Goal(id="G-001", statement="允许管理员导出数据"),),
            "requirements": (requirement,),
            "acceptance_criteria": (criterion,),
        }
    )
    return Specification.model_validate(payload)


def test_empty_spec_is_not_ready_for_approval() -> None:
    """缺少目标和需求的 Spec 不能进入批准阶段。"""

    report = validate_specification(create_specification("数据导出", now=NOW))

    assert report.ready_for_approval is False
    assert {issue.code for issue in report.issues} == {"missing_goal", "missing_requirement"}


def test_covered_spec_is_ready_for_approval() -> None:
    """目标明确且所有需求有双向验收覆盖时通过验证。"""

    report = validate_specification(build_valid_spec())

    assert report.ready_for_approval is True
    assert report.issues == ()


def test_blocking_open_question_prevents_approval() -> None:
    """有效的阻塞性 OpenQuestion 必须先得到解决。"""

    spec = build_valid_spec()
    payload = spec.model_dump()
    payload["open_questions"] = (
        OpenQuestion(id="OQ-001", statement="谁可以导出？", blocking=True),
    )

    report = validate_specification(Specification.model_validate(payload))

    assert report.ready_for_approval is False
    assert report.issues[0].code == "blocking_open_question"


def test_retired_requirement_does_not_count_as_coverage() -> None:
    """已停用需求不能让 Spec 虚假满足最小 Requirement 条件。"""

    spec = build_valid_spec()
    payload = spec.model_dump()
    payload["requirements"] = (spec.requirements[0].model_copy(update={"lifecycle": "retired"}),)

    report = validate_specification(Specification.model_validate(payload))

    assert report.ready_for_approval is False
    assert "missing_requirement" in {issue.code for issue in report.issues}

"""结构化 Spec 领域不变量的行为测试。"""

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from specpilot.spec.models import (
    AcceptanceCriterion,
    Evidence,
    OpenQuestion,
    Requirement,
    Specification,
    create_specification,
)

NOW = datetime(2026, 9, 5, 8, 0, tzinfo=UTC)


def test_new_spec_has_stable_runtime_identity_and_initial_version() -> None:
    """空白 Spec 由运行时代码分配 ID、时间和初始版本。"""

    spec = create_specification("数据导出", now=NOW)

    assert spec.spec_id.startswith("SP-")
    assert spec.version == 1
    assert spec.status == "draft"
    assert spec.created_at == NOW
    assert spec.updated_at == NOW


def test_spec_rejects_dangling_evidence_reference() -> None:
    """实体不能声称拥有实际不存在的证据来源。"""

    spec = create_specification("数据导出", now=NOW)
    requirement = Requirement(id="R-001", statement="仅管理员可以导出", evidence_ids=("E-999",))

    with pytest.raises(ValidationError, match="不存在的 Evidence"):
        spec.model_copy(update={"requirements": (requirement,)}).model_validate(
            spec.model_copy(update={"requirements": (requirement,)}).model_dump()
        )


def test_spec_accepts_linked_requirement_and_acceptance_criterion() -> None:
    """Requirement 与 AcceptanceCriterion 可以通过稳定 ID 双向关联。"""

    spec = create_specification("数据导出", now=NOW)
    evidence = Evidence(
        id="E-001",
        kind="clarification",
        summary="用户选择仅管理员导出",
        locator="Q-abc123",
        captured_at=NOW,
    )
    requirement = Requirement(
        id="R-001",
        statement="仅管理员可以导出",
        evidence_ids=("E-001",),
        acceptance_criterion_ids=("AC-001",),
    )
    criterion = AcceptanceCriterion(
        id="AC-001",
        statement="普通用户无法执行导出",
        requirement_ids=("R-001",),
        given="当前用户不是管理员",
        when="用户请求导出",
        then="系统拒绝请求",
    )

    payload = spec.model_dump()
    payload.update(
        {
            "requirements": (requirement,),
            "acceptance_criteria": (criterion,),
            "evidence": (evidence,),
        }
    )
    validated = Specification.model_validate(payload)

    assert validated.requirements[0].acceptance_criterion_ids == ("AC-001",)


def test_open_question_resolution_requires_a_decision() -> None:
    """已解决问题不能缺少对应 Decision。"""

    with pytest.raises(ValidationError, match="必须引用 Decision"):
        OpenQuestion(
            id="OQ-001",
            statement="谁可以导出？",
            blocking=True,
            status="resolved",
        )


def test_partial_bdd_scenario_is_rejected() -> None:
    """BDD 场景不能只提供 Given/When/Then 的一部分。"""

    with pytest.raises(ValidationError, match="必须同时提供"):
        AcceptanceCriterion(
            id="AC-001",
            statement="导出成功",
            requirement_ids=("R-001",),
            given="用户是管理员",
        )

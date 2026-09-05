"""定义结构化 Specification 的最小领域模型和引用不变量。"""

from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


class SpecEntity(BaseModel):
    """所有 Spec 实体共享的不可变字段。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    id: str
    statement: str = Field(min_length=1, max_length=2_000)
    evidence_ids: tuple[str, ...] = ()


class Goal(SpecEntity):
    """用户希望本次变更最终达成的结果。"""

    id: str = Field(pattern=r"^G-[0-9]{3}$")


class ScopeItem(SpecEntity):
    """明确纳入或排除在本次变更之外的范围项。"""

    id: str = Field(pattern=r"^S-[0-9]{3}$")
    disposition: Literal["in_scope", "out_of_scope"]


class Requirement(SpecEntity):
    """必须满足且可以验证的产品行为或约束。"""

    id: str = Field(pattern=r"^R-[0-9]{3}$")
    acceptance_criterion_ids: tuple[str, ...] = ()


class Decision(SpecEntity):
    """已经由用户或现有项目约束确认的选择。"""

    id: str = Field(pattern=r"^D-[0-9]{3}$")
    rationale: str = Field(min_length=1, max_length=2_000)
    made_by: Literal["user", "project"]
    decided_at: AwareDatetime
    supersedes_id: str | None = Field(default=None, pattern=r"^D-[0-9]{3}$")


class Assumption(SpecEntity):
    """尚未确认、但允许 Agent 暂时采用的可撤销判断。"""

    id: str = Field(pattern=r"^A-[0-9]{3}$")
    confidence: float = Field(ge=0, le=1)
    impact: str = Field(min_length=1, max_length=1_000)
    invalidation_condition: str = Field(min_length=1, max_length=1_000)


class OpenQuestion(SpecEntity):
    """尚待调查或等待用户决定的问题。"""

    id: str = Field(pattern=r"^OQ-[0-9]{3}$")
    blocking: bool
    status: Literal["open", "resolved"] = "open"
    resolution_decision_id: str | None = Field(default=None, pattern=r"^D-[0-9]{3}$")

    @model_validator(mode="after")
    def validate_resolution(self) -> "OpenQuestion":
        """保证问题状态和解决它的 Decision 引用保持一致。"""

        has_resolution = self.resolution_decision_id is not None
        if (self.status == "resolved") != has_resolution:
            raise ValueError("已解决问题必须引用 Decision，未解决问题不能提前引用")
        return self


class AcceptanceCriterion(SpecEntity):
    """描述 Requirement 如何被观察或验证的验收条件。"""

    id: str = Field(pattern=r"^AC-[0-9]{3}$")
    requirement_ids: tuple[str, ...] = Field(min_length=1)
    given: str | None = Field(default=None, min_length=1, max_length=1_000)
    when: str | None = Field(default=None, min_length=1, max_length=1_000)
    then: str | None = Field(default=None, min_length=1, max_length=1_000)

    @model_validator(mode="after")
    def validate_bdd_scenario(self) -> "AcceptanceCriterion":
        """BDD 场景要么完整提供 Given/When/Then，要么完全省略。"""

        scenario_parts = (self.given, self.when, self.then)
        if any(part is not None for part in scenario_parts) and not all(
            part is not None for part in scenario_parts
        ):
            raise ValueError("BDD 场景必须同时提供 given、when 和 then")
        return self


class Evidence(BaseModel):
    """支持 Spec 结论的用户回答、仓库事实或运行结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    id: str = Field(pattern=r"^E-[0-9]{3}$")
    kind: Literal["user_statement", "clarification", "repository", "tool_result", "test"]
    summary: str = Field(min_length=1, max_length=2_000)
    locator: str = Field(min_length=1, max_length=2_000)
    captured_at: AwareDatetime


class Specification(BaseModel):
    """Spec 的结构化事实源；Markdown 只能由它投影生成。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: Literal[1] = 1
    spec_id: str = Field(pattern=r"^SP-[0-9a-f]{12}$")
    version: int = Field(default=1, ge=1)
    status: Literal["draft", "clarifying", "ready_for_approval", "approved", "revised"] = "draft"
    title: str = Field(min_length=1, max_length=200)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    goals: tuple[Goal, ...] = ()
    scope: tuple[ScopeItem, ...] = ()
    requirements: tuple[Requirement, ...] = ()
    decisions: tuple[Decision, ...] = ()
    assumptions: tuple[Assumption, ...] = ()
    open_questions: tuple[OpenQuestion, ...] = ()
    acceptance_criteria: tuple[AcceptanceCriterion, ...] = ()
    evidence: tuple[Evidence, ...] = ()

    @model_validator(mode="after")
    def validate_references(self) -> "Specification":
        """拒绝重复 ID 和指向不存在实体的引用。"""

        entities: tuple[SpecEntity | Evidence, ...] = (
            *self.goals,
            *self.scope,
            *self.requirements,
            *self.decisions,
            *self.assumptions,
            *self.open_questions,
            *self.acceptance_criteria,
            *self.evidence,
        )
        entity_ids = [entity.id for entity in entities]
        if len(entity_ids) != len(set(entity_ids)):
            raise ValueError("同一个 Spec 中的实体 ID 必须唯一")

        evidence_ids = {item.id for item in self.evidence}
        for entity in entities:
            if isinstance(entity, Evidence):
                continue
            missing_evidence = set(entity.evidence_ids) - evidence_ids
            if missing_evidence:
                raise ValueError(f"实体 {entity.id} 引用了不存在的 Evidence")

        requirement_ids = {item.id for item in self.requirements}
        acceptance_ids = {item.id for item in self.acceptance_criteria}
        decision_ids = {item.id for item in self.decisions}
        for criterion in self.acceptance_criteria:
            if set(criterion.requirement_ids) - requirement_ids:
                raise ValueError(f"验收条件 {criterion.id} 引用了不存在的 Requirement")
        for requirement in self.requirements:
            if set(requirement.acceptance_criterion_ids) - acceptance_ids:
                raise ValueError(f"需求 {requirement.id} 引用了不存在的 AcceptanceCriterion")
        for question in self.open_questions:
            if question.resolution_decision_id not in decision_ids | {None}:
                raise ValueError(f"问题 {question.id} 引用了不存在的 Decision")
        for decision in self.decisions:
            if decision.supersedes_id not in decision_ids | {None}:
                raise ValueError(f"决策 {decision.id} 引用了不存在的旧 Decision")
        return self


def create_specification(title: str, now: datetime | None = None) -> Specification:
    """创建一个带运行时 ID 和 UTC 时间的空白 Spec。"""

    timestamp = now or datetime.now(UTC)
    return Specification(
        spec_id=f"SP-{uuid4().hex[:12]}",
        title=title,
        created_at=timestamp,
        updated_at=timestamp,
    )

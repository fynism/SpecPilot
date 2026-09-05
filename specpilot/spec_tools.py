"""提供读取和原子修改当前 Specification 的模型工具。"""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from specpilot.models import EmptyInput, ToolInput
from specpilot.spec import (
    AcceptanceCriterion,
    Assumption,
    Decision,
    Evidence,
    Goal,
    OpenQuestion,
    Requirement,
    ScopeItem,
    Specification,
    create_specification,
)
from specpilot.spec_store import InMemorySpecStore, SpecStore
from specpilot.spec_validation import report_as_json


class PatchOperation(BaseModel):
    """所有 Spec Patch 操作共享的严格输入边界。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class PutGoal(PatchOperation):
    """新增或修订一个 Goal。"""

    op: Literal["put_goal"]
    id: str = Field(pattern=r"^G-[0-9]{3}$")
    statement: str = Field(min_length=1, max_length=2_000)
    evidence_ids: list[str] = Field(default_factory=list)


class PutScopeItem(PatchOperation):
    """新增或修订一个范围项。"""

    op: Literal["put_scope_item"]
    id: str = Field(pattern=r"^S-[0-9]{3}$")
    statement: str = Field(min_length=1, max_length=2_000)
    evidence_ids: list[str] = Field(default_factory=list)
    disposition: Literal["in_scope", "out_of_scope"]


class PutRequirement(PatchOperation):
    """新增或修订一个 Requirement。"""

    op: Literal["put_requirement"]
    id: str = Field(pattern=r"^R-[0-9]{3}$")
    statement: str = Field(min_length=1, max_length=2_000)
    evidence_ids: list[str] = Field(default_factory=list)
    acceptance_criterion_ids: list[str] = Field(default_factory=list)


class RecordDecision(PatchOperation):
    """记录一个由用户或项目事实确认的 Decision。"""

    op: Literal["record_decision"]
    id: str = Field(pattern=r"^D-[0-9]{3}$")
    statement: str = Field(min_length=1, max_length=2_000)
    evidence_ids: list[str] = Field(min_length=1)
    rationale: str = Field(min_length=1, max_length=2_000)
    made_by: Literal["user", "project"]
    supersedes_id: str | None = Field(default=None, pattern=r"^D-[0-9]{3}$")


class PutAssumption(PatchOperation):
    """新增或修订一个显式 Assumption。"""

    op: Literal["put_assumption"]
    id: str = Field(pattern=r"^A-[0-9]{3}$")
    statement: str = Field(min_length=1, max_length=2_000)
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    impact: str = Field(min_length=1, max_length=1_000)
    invalidation_condition: str = Field(min_length=1, max_length=1_000)


class PutOpenQuestion(PatchOperation):
    """新增、修订或解决一个 OpenQuestion。"""

    op: Literal["put_open_question"]
    id: str = Field(pattern=r"^OQ-[0-9]{3}$")
    statement: str = Field(min_length=1, max_length=2_000)
    evidence_ids: list[str] = Field(default_factory=list)
    blocking: bool
    status: Literal["open", "resolved"] = "open"
    resolution_decision_id: str | None = Field(default=None, pattern=r"^D-[0-9]{3}$")


class PutAcceptanceCriterion(PatchOperation):
    """新增或修订一个验收条件及可选 BDD 场景。"""

    op: Literal["put_acceptance_criterion"]
    id: str = Field(pattern=r"^AC-[0-9]{3}$")
    statement: str = Field(min_length=1, max_length=2_000)
    evidence_ids: list[str] = Field(default_factory=list)
    requirement_ids: list[str] = Field(min_length=1)
    given: str | None = Field(default=None, min_length=1, max_length=1_000)
    when: str | None = Field(default=None, min_length=1, max_length=1_000)
    then: str | None = Field(default=None, min_length=1, max_length=1_000)


class RecordEvidence(PatchOperation):
    """记录支持其他 Spec 实体的可追溯 Evidence。"""

    op: Literal["record_evidence"]
    id: str = Field(pattern=r"^E-[0-9]{3}$")
    kind: Literal["user_statement", "clarification", "repository", "tool_result", "test"]
    summary: str = Field(min_length=1, max_length=2_000)
    locator: str = Field(min_length=1, max_length=2_000)


class RetireItem(PatchOperation):
    """让一个实体在新版本中失效，同时由版本历史保留原内容。"""

    op: Literal["retire_item"]
    id: str = Field(pattern=r"^(G|S|R|D|A|OQ|AC)-[0-9]{3}$")


class SetSpecMetadata(PatchOperation):
    """更新 Spec 标题或非批准生命周期状态。"""

    op: Literal["set_spec_metadata"]
    title: str | None = Field(default=None, min_length=1, max_length=200)
    status: Literal["draft", "clarifying", "ready_for_approval", "revised"] | None = None


SpecPatchOperation = Annotated[
    PutGoal
    | PutScopeItem
    | PutRequirement
    | RecordDecision
    | PutAssumption
    | PutOpenQuestion
    | PutAcceptanceCriterion
    | RecordEvidence
    | RetireItem
    | SetSpecMetadata,
    Field(discriminator="op"),
]


class ApplySpecPatchInput(ToolInput):
    """对当前 Spec 执行原子语义修改所需的输入。"""

    expected_version: int = Field(ge=1, description="调用方读取到的当前 Spec 版本。")
    change_reason: str = Field(min_length=1, max_length=1_000, description="本次修改的原因。")
    operations: list[SpecPatchOperation] = Field(min_length=1, max_length=20)


class SpecToolService:
    """管理当前单会话 Spec，并为 Agent 暴露受控读写入口。"""

    def __init__(
        self,
        store: SpecStore,
        spec_id: str,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        """绑定 Store、当前 Spec ID 和运行时时钟。"""

        self._store = store
        self._spec_id = spec_id
        self._clock = clock or (lambda: datetime.now(UTC))

    @classmethod
    def create(
        cls,
        title: str = "当前需求",
        store: SpecStore | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> "SpecToolService":
        """创建空白 Spec，并返回绑定它的工具服务。"""

        runtime_clock = clock or (lambda: datetime.now(UTC))
        runtime_store = store or InMemorySpecStore(clock=runtime_clock)
        spec = runtime_store.create(create_specification(title, now=runtime_clock()))
        return cls(runtime_store, spec.spec_id, runtime_clock)

    @property
    def spec_id(self) -> str:
        """返回当前会话绑定的 Spec ID。"""

        return self._spec_id

    def get_spec(self, _: EmptyInput) -> str:
        """返回当前 Spec 最新版本的完整 JSON 事实源。"""

        return self._store.get(self._spec_id).model_dump_json()

    def current_spec(self) -> Specification:
        """向同一组合根中的验证和导出能力提供最新不可变快照。"""

        return self._store.get(self._spec_id)

    def validate_spec(self, _: EmptyInput) -> str:
        """确定性检查当前 Spec 是否具备进入人工批准阶段的条件。"""

        return report_as_json(self.current_spec())

    @staticmethod
    def _put(items: tuple[object, ...], replacement: object) -> tuple[object, ...]:
        """按稳定 ID 新增或替换实体，并保持原有顺序。"""

        replacement_id = getattr(replacement, "id")
        replaced = False
        updated: list[object] = []
        for item in items:
            if getattr(item, "id") == replacement_id:
                updated.append(replacement)
                replaced = True
            else:
                updated.append(item)
        if not replaced:
            updated.append(replacement)
        return tuple(updated)

    @staticmethod
    def _retire(spec: Specification, entity_id: str) -> dict[str, object]:
        """把目标实体标为 retired；Evidence 只作为来源记录，不能被退休。"""

        updates: dict[str, object] = {}
        for field_name in (
            "goals",
            "scope",
            "requirements",
            "decisions",
            "assumptions",
            "open_questions",
            "acceptance_criteria",
        ):
            items = getattr(spec, field_name)
            for item in items:
                if item.id == entity_id:
                    updates[field_name] = SpecToolService._put(
                        items, item.model_copy(update={"lifecycle": "retired"})
                    )
                    return updates
        raise ValueError(f"要停用的 Spec 实体不存在：{entity_id}")

    def apply_spec_patch(self, tool_input: ApplySpecPatchInput) -> str:
        """在内存快照上应用全部操作，校验成功后一次性追加版本。"""

        current = self._store.get(self._spec_id)
        if current.version != tool_input.expected_version:
            raise ValueError(
                f"Spec 版本冲突：期望 {tool_input.expected_version}，当前 {current.version}"
            )

        working = current.model_copy(update={"change_reason": tool_input.change_reason})
        for operation in tool_input.operations:
            # 所有操作先作用于内存快照；model_copy 暂不校验跨实体引用，让同一 Patch
            # 可以先引用后创建，整批完成后再统一执行严格校验和一次性保存。
            if isinstance(operation, PutGoal):
                goal = Goal(
                    id=operation.id,
                    statement=operation.statement,
                    evidence_ids=tuple(operation.evidence_ids),
                )
                working = working.model_copy(update={"goals": self._put(working.goals, goal)})
            elif isinstance(operation, PutScopeItem):
                scope_item = ScopeItem(
                    id=operation.id,
                    statement=operation.statement,
                    evidence_ids=tuple(operation.evidence_ids),
                    disposition=operation.disposition,
                )
                working = working.model_copy(update={"scope": self._put(working.scope, scope_item)})
            elif isinstance(operation, PutRequirement):
                requirement = Requirement(
                    id=operation.id,
                    statement=operation.statement,
                    evidence_ids=tuple(operation.evidence_ids),
                    acceptance_criterion_ids=tuple(operation.acceptance_criterion_ids),
                )
                working = working.model_copy(
                    update={"requirements": self._put(working.requirements, requirement)}
                )
            elif isinstance(operation, RecordDecision):
                decision = Decision(
                    id=operation.id,
                    statement=operation.statement,
                    evidence_ids=tuple(operation.evidence_ids),
                    rationale=operation.rationale,
                    made_by=operation.made_by,
                    decided_at=self._clock(),
                    supersedes_id=operation.supersedes_id,
                )
                working = working.model_copy(
                    update={"decisions": self._put(working.decisions, decision)}
                )
            elif isinstance(operation, PutAssumption):
                assumption = Assumption(
                    id=operation.id,
                    statement=operation.statement,
                    evidence_ids=tuple(operation.evidence_ids),
                    confidence=operation.confidence,
                    impact=operation.impact,
                    invalidation_condition=operation.invalidation_condition,
                )
                working = working.model_copy(
                    update={"assumptions": self._put(working.assumptions, assumption)}
                )
            elif isinstance(operation, PutOpenQuestion):
                open_question = OpenQuestion(
                    id=operation.id,
                    statement=operation.statement,
                    evidence_ids=tuple(operation.evidence_ids),
                    blocking=operation.blocking,
                    status=operation.status,
                    resolution_decision_id=operation.resolution_decision_id,
                )
                working = working.model_copy(
                    update={"open_questions": self._put(working.open_questions, open_question)}
                )
            elif isinstance(operation, PutAcceptanceCriterion):
                acceptance_criterion = AcceptanceCriterion(
                    id=operation.id,
                    statement=operation.statement,
                    evidence_ids=tuple(operation.evidence_ids),
                    requirement_ids=tuple(operation.requirement_ids),
                    given=operation.given,
                    when=operation.when,
                    then=operation.then,
                )
                working = working.model_copy(
                    update={
                        "acceptance_criteria": self._put(
                            working.acceptance_criteria, acceptance_criterion
                        )
                    }
                )
            elif isinstance(operation, RecordEvidence):
                evidence = Evidence(
                    id=operation.id,
                    kind=operation.kind,
                    summary=operation.summary,
                    locator=operation.locator,
                    captured_at=self._clock(),
                )
                working = working.model_copy(
                    update={"evidence": self._put(working.evidence, evidence)}
                )
            elif isinstance(operation, RetireItem):
                working = working.model_copy(update=self._retire(working, operation.id))
            elif isinstance(operation, SetSpecMetadata):
                metadata_updates: dict[str, object] = {}
                if operation.title is not None:
                    metadata_updates["title"] = operation.title
                if operation.status is not None:
                    metadata_updates["status"] = operation.status
                working = working.model_copy(update=metadata_updates)

        # Patch 中的交叉引用可以指向同一批操作后创建的实体，因此只在整批完成后最终校验。
        candidate = Specification.model_validate(working.model_dump())
        saved = self._store.save(candidate, expected_version=tool_input.expected_version)
        return saved.model_dump_json()

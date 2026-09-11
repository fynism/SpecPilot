"""定义首批 Agent 场景 Eval 的数据契约和确定性轨迹评分。"""

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class EvalExpectation(BaseModel):
    """一个场景必须出现和绝不能出现的关键行为。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    required_tools: tuple[str, ...] = ()
    forbidden_tools: tuple[str, ...] = ()
    min_clarifications: int = Field(default=0, ge=0)
    max_clarifications: int = Field(default=0, ge=0)
    required_spec_entities: tuple[str, ...] = ()


class EvalCase(BaseModel):
    """可版本化、可针对受控仓库重复运行的一条行为样本。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    id: str
    category: str
    user_input: str
    fixture: str
    scoring: Literal["deterministic_trace_v1"]
    expectation: EvalExpectation


class AgentTrace(BaseModel):
    """从一次 Agent 运行中提取的结构化行为轨迹。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    tools: tuple[str, ...] = ()
    clarification_count: int = Field(default=0, ge=0)
    spec_entities: tuple[str, ...] = ()


class EvalScore(BaseModel):
    """不依赖 LLM Judge 的单场景评分结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    passed: bool
    checks_passed: int
    checks_total: int
    violations: tuple[str, ...]


def load_eval_cases(path: Path) -> tuple[EvalCase, ...]:
    """从 JSON 文件读取并严格校验 Eval 数据集。"""

    # JSON 数组在严格模式下可以自然映射为不可变 tuple，无需先转成宽松 Python 对象。
    return TypeAdapter(tuple[EvalCase, ...]).validate_json(path.read_text(encoding="utf-8"))


def score_trace(case: EvalCase, trace: AgentTrace) -> EvalScore:
    """按工具、澄清次数和 Spec 实体对轨迹执行确定性评分。"""

    violations: list[str] = []
    expectation = case.expectation
    missing_tools = set(expectation.required_tools) - set(trace.tools)
    used_forbidden_tools = set(expectation.forbidden_tools) & set(trace.tools)
    missing_entities = set(expectation.required_spec_entities) - set(trace.spec_entities)
    if missing_tools:
        violations.append(f"缺少必要工具：{sorted(missing_tools)}")
    if used_forbidden_tools:
        violations.append(f"调用禁止工具：{sorted(used_forbidden_tools)}")
    if not (
        expectation.min_clarifications
        <= trace.clarification_count
        <= expectation.max_clarifications
    ):
        violations.append("澄清次数不在允许范围内")
    if missing_entities:
        violations.append(f"缺少 Spec 实体：{sorted(missing_entities)}")
    return EvalScore(
        passed=not violations,
        checks_passed=4 - len(violations),
        checks_total=4,
        violations=tuple(violations),
    )

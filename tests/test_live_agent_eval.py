"""按显式开关运行、会产生真实模型费用的 Agent 场景 Eval。"""

import os
from pathlib import Path

import pytest

from specpilot.capabilities.clarification.models import ClarificationAnswer, ClarificationRequest
from specpilot.capabilities.clarification.tool import ClarificationPresenter
from specpilot.capabilities.spec.models import Specification
from specpilot.capabilities.spec.operations import SpecToolService
from specpilot.config import load_settings
from specpilot.evaluation.scoring import AgentTrace, load_eval_cases, score_trace
from specpilot.integrations.anthropic.model import AnthropicModelClient
from specpilot.runtime import agent
from specpilot.runtime.hooks import HookRegistry
from specpilot.runtime.model import Message, ModelBlock, ModelClient
from specpilot.tooling.catalog import build_default_registry
from specpilot.tooling.contracts import ToolCall, ToolSpec
from specpilot.tooling.executor import ToolExecutor

ROOT = Path(__file__).resolve().parent.parent
RUN_LIVE = os.getenv("SPECPILOT_RUN_LIVE_EVALS") == "1"


class RecommendedPresenter(ClarificationPresenter):
    """真实 Eval 中模拟用户明确确认模型推荐项。"""

    def __init__(self) -> None:
        self.count = 0

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """选择已展示的推荐项，并记录澄清次数。"""

        self.count += 1
        return ClarificationAnswer(
            request_id=request.request_id,
            selected_option_id=request.recommended_option_id,
        )


class CappedModelClient(ModelClient):
    """限制真实 Eval 的模型轮次，防止异常轨迹无限消耗。"""

    def __init__(self, inner: ModelClient, max_calls: int = 12) -> None:
        self._inner = inner
        self._max_calls = max_calls
        self.calls = 0

    def create_message(
        self,
        messages: list[Message],
        tools: tuple[ToolSpec, ...],
        system: str,
        max_tokens: int,
    ) -> tuple[ModelBlock, ...]:
        """在预算内转发模型调用，超限时让 Eval 明确失败。"""

        self.calls += 1
        if self.calls > self._max_calls:
            raise RuntimeError("真实 Eval 超过最大模型轮次")
        return self._inner.create_message(messages, tools, system, max_tokens)


def entity_types(spec: Specification) -> tuple[str, ...]:
    """把最终 Spec 快照投影成 Eval 使用的实体类型集合。"""

    found: list[str] = []
    mappings = (
        ("goal", spec.goals),
        ("scope", spec.scope),
        ("requirement", spec.requirements),
        ("decision", spec.decisions),
        ("assumption", spec.assumptions),
        ("open_question", spec.open_questions),
        ("acceptance_criterion", spec.acceptance_criteria),
        ("evidence", spec.evidence),
    )
    for name, items in mappings:
        if items:
            found.append(name)
    return tuple(found)


@pytest.mark.skipif(not RUN_LIVE, reason="设置 SPECPILOT_RUN_LIVE_EVALS=1 后运行真实模型 Eval")
def test_live_model_handles_explicit_export_requirement(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """真实模型应把明确导出需求整理成经过校验的 Spec，且不多问。"""

    case = load_eval_cases(ROOT / "evals" / "cases.json")[0]
    fixture_file = ROOT / case.fixture / "project.json"
    (tmp_path / "project.json").write_text(fixture_file.read_text(encoding="utf-8"), "utf-8")
    settings = load_settings()
    presenter = RecommendedPresenter()
    calls: list[str] = []
    hooks = HookRegistry()

    def record_tool(call: ToolCall) -> None:
        """记录真实模型选择的工具轨迹。"""

        calls.append(call.name)

    hooks.register("PreToolUse", record_tool)
    spec_service = SpecToolService.create(title="真实模型 Eval")
    registry = build_default_registry(presenter, hooks.trigger, tmp_path, spec_service)
    executor = ToolExecutor(registry, hooks.trigger)
    model = CappedModelClient(
        AnthropicModelClient(settings.api_key, settings.model, settings.base_url)
    )
    monkeypatch.setattr(agent, "CLIENT", model)
    monkeypatch.setattr(agent, "HOOKS", hooks)
    monkeypatch.setattr(agent, "TOOL_REGISTRY", registry)
    monkeypatch.setattr(agent, "TOOL_EXECUTOR", executor)
    history: list[Message] = [{"role": "user", "content": case.user_input}]

    agent.agent_loop(history)

    trace = AgentTrace(
        tools=tuple(calls),
        clarification_count=presenter.count,
        spec_entities=entity_types(spec_service.current_spec()),
    )
    score = score_trace(case, trace)
    assert score.passed, score.model_dump_json(indent=2)

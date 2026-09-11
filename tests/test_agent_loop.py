"""传统 Agent Loop 跨工具多步运行的集成测试。"""

from collections.abc import Iterable
from typing import Any

from specpilot.capabilities.clarification.models import ClarificationAnswer, ClarificationRequest
from specpilot.capabilities.clarification.policy import ClarificationStopController
from specpilot.capabilities.clarification.tool import ClarificationPresenter
from specpilot.capabilities.spec.operations import SpecToolService
from specpilot.runtime import agent
from specpilot.runtime.hooks import HookRegistry
from specpilot.runtime.model import ModelBlock, TextBlock, ToolUseBlock
from specpilot.tooling.catalog import build_default_registry
from specpilot.tooling.contracts import ToolSpec
from specpilot.tooling.executor import ToolExecutor


class QueuePresenter(ClarificationPresenter):
    """依次返回预设选项，并保留展示过的问题。"""

    def __init__(self, choices: Iterable[str]) -> None:
        self._choices = iter(choices)
        self.requests: list[ClarificationRequest] = []

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """把下一项用户选择绑定到当前请求 ID。"""

        self.requests.append(request)
        return ClarificationAnswer(
            request_id=request.request_id,
            selected_option_id=next(self._choices),
        )


class StoppingPresenter(ClarificationPresenter):
    """模拟用户在澄清输入框中明确要求到此为止。"""

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """把结束表达作为本次澄清的自由回答。"""

        return ClarificationAnswer(request_id=request.request_id, free_text="到此为止")


class ScriptedClient:
    """模拟模型适配边界，每轮返回一批预设响应块。"""

    def __init__(self, responses: Iterable[tuple[ModelBlock, ...]]) -> None:
        self._responses = iter(responses)
        self.call_count = 0
        self.exposed_tools: list[tuple[ToolSpec, ...]] = []
        self.system_prompts: list[str] = []

    def create_message(
        self,
        messages: list[dict[str, Any]],
        tools: tuple[ToolSpec, ...],
        system: str,
        max_tokens: int,
    ) -> tuple[ModelBlock, ...]:
        """返回下一轮内容，并记录模型调用次数。"""

        self.call_count += 1
        self.exposed_tools.append(tools)
        self.system_prompts.append(system)
        return next(self._responses)


def tool_call(call_id: str, name: str, tool_input: dict[str, Any]) -> ToolUseBlock:
    """构造一条供应商风格的工具调用块。"""

    return ToolUseBlock(id=call_id, name=name, input=tool_input)


def clarification(question: str) -> dict[str, Any]:
    """构造一个包含明确默认推荐的澄清工具参数。"""

    return {
        "question": question,
        "reason": "该选择会改变需求与验收条件。",
        "options": [
            {"id": "recommended", "label": "推荐方案", "description": "保持最小范围。"},
            {"id": "expanded", "label": "扩展方案", "description": "增加首版范围。"},
        ],
        "recommended_option_id": "recommended",
        "recommendation_reason": "推荐方案更符合 MVP 边界。",
        "allow_custom_answer": True,
    }


def test_agent_loop_runs_tools_until_a_plain_response(monkeypatch: Any, tmp_path: Any) -> None:
    """一次 Loop 可完成调查、两次澄清、Spec 更新、校验并自然结束。"""

    (tmp_path / "roles.txt").write_text("admin\nmember\n", encoding="utf-8")
    presenter = QueuePresenter(["recommended", "expanded"])
    spec_service = SpecToolService.create(title="导出功能")
    hooks = HookRegistry()
    registry = build_default_registry(presenter, hooks.trigger, tmp_path, spec_service)
    executor = ToolExecutor(registry, hooks.trigger)
    patch = {
        "expected_version": 1,
        "change_reason": "根据两次用户澄清形成可验收需求",
        "operations": [
            {
                "op": "record_evidence",
                "id": "E-001",
                "kind": "clarification",
                "summary": "用户确认导出权限范围",
                "locator": "clarification:permission",
            },
            {"op": "put_goal", "id": "G-001", "statement": "支持导出项目数据"},
            {
                "op": "put_requirement",
                "id": "R-001",
                "statement": "管理员可以导出项目数据",
                "evidence_ids": ["E-001"],
                "acceptance_criterion_ids": ["AC-001"],
            },
            {
                "op": "put_acceptance_criterion",
                "id": "AC-001",
                "statement": "管理员发起导出后获得文件",
                "requirement_ids": ["R-001"],
            },
        ],
    }
    responses: list[tuple[ModelBlock, ...]] = [
        (tool_call("t1", "list_repository_files", {}),),
        (tool_call("t2", "request_clarification", clarification("谁可以导出？")),),
        (tool_call("t3", "request_clarification", clarification("首版使用哪种格式？")),),
        (tool_call("t4", "get_spec", {}),),
        (tool_call("t5", "apply_spec_patch", patch),),
        (tool_call("t6", "validate_spec", {}),),
        (TextBlock(text="需求已经完成澄清并通过校验。"),),
    ]
    client = ScriptedClient(responses)
    monkeypatch.setattr(agent, "CLIENT", client)
    monkeypatch.setattr(agent, "HOOKS", hooks)
    monkeypatch.setattr(agent, "TOOL_REGISTRY", registry)
    monkeypatch.setattr(agent, "TOOL_EXECUTOR", executor)
    history: list[dict[str, Any]] = [{"role": "user", "content": "增加导出功能"}]

    stop_reason = agent.agent_loop(history)

    assert stop_reason == "model_complete"
    assert client.call_count == 7
    assert len(presenter.requests) == 2
    assert spec_service.current_spec().version == 2
    assert spec_service.current_spec().requirements[0].id == "R-001"
    tool_result_ids = [
        block["tool_use_id"]
        for message in history
        if message["role"] == "user" and isinstance(message["content"], list)
        for block in message["content"]
    ]
    assert tool_result_ids == ["t1", "t2", "t3", "t4", "t5", "t6"]
    assert history[-1]["role"] == "assistant"
    assert history[-1]["content"][0]["text"] == "需求已经完成澄清并通过校验。"


def test_agent_loop_stops_after_configured_tool_use_turns(monkeypatch: Any, tmp_path: Any) -> None:
    """达到工具轮次上限后保留最后一轮结果，并把控制权交还 CLI。"""

    presenter = QueuePresenter([])
    hooks = HookRegistry()
    registry = build_default_registry(presenter, hooks.trigger, tmp_path)
    executor = ToolExecutor(registry, hooks.trigger)
    responses: list[tuple[ModelBlock, ...]] = [
        (
            tool_call("t1", "list_repository_files", {}),
            tool_call("t2", "get_spec", {}),
        ),
        (tool_call("t3", "validate_spec", {}),),
        (TextBlock(text="已继续处理"),),
    ]
    client = ScriptedClient(responses)
    monkeypatch.setattr(agent, "CLIENT", client)
    monkeypatch.setattr(agent, "HOOKS", hooks)
    monkeypatch.setattr(agent, "TOOL_REGISTRY", registry)
    monkeypatch.setattr(agent, "TOOL_EXECUTOR", executor)
    monkeypatch.setattr(agent, "MAX_TOOL_USE_TURNS", 2)
    history: list[dict[str, Any]] = [{"role": "user", "content": "整理需求"}]

    stop_reason = agent.agent_loop(history)

    assert stop_reason == "max_tool_use_turns"
    assert client.call_count == 2
    assert [block["tool_use_id"] for block in history[-1]["content"]] == ["t3"]

    history.append({"role": "user", "content": "继续整理"})
    resumed_reason = agent.agent_loop(history)

    assert resumed_reason == "model_complete"
    assert client.call_count == 3
    assert history[-1]["content"][0]["text"] == "已继续处理"


def test_final_response_turn_never_executes_tools(monkeypatch: Any, tmp_path: Any) -> None:
    """用户结束澄清后的总结轮不暴露工具，并拒绝适配器异常返回的调用。"""

    presenter = QueuePresenter([])
    hooks = HookRegistry()
    registry = build_default_registry(presenter, hooks.trigger, tmp_path)
    executor = ToolExecutor(registry, hooks.trigger)
    responses: list[tuple[ModelBlock, ...]] = [
        (tool_call("unexpected", "get_spec", {}),),
        (TextBlock(text="以下是基于已有对话的总结。"),),
    ]
    client = ScriptedClient(responses)
    monkeypatch.setattr(agent, "CLIENT", client)
    monkeypatch.setattr(agent, "HOOKS", hooks)
    monkeypatch.setattr(agent, "TOOL_REGISTRY", registry)
    monkeypatch.setattr(agent, "TOOL_EXECUTOR", executor)
    executed: list[str] = []

    def record_unexpected_execution(name: str, _input: dict[str, Any]) -> str:
        """记录任何越过总结轮边界的工具执行。"""

        executed.append(name)
        return ""

    monkeypatch.setattr(executor, "execute", record_unexpected_execution)
    history: list[dict[str, Any]] = [{"role": "user", "content": "到此为止"}]

    stop_reason = agent.agent_loop(history, tools_enabled=False)

    assert stop_reason == "model_complete"
    assert executed == []
    assert client.exposed_tools == [(), ()]
    assert all("No tools are available" in system for system in client.system_prompts)
    assert "本轮禁止调用工具" in history[2]["content"][0]["content"]


def test_stop_answer_inside_clarification_disables_following_tools(
    monkeypatch: Any,
    tmp_path: Any,
) -> None:
    """输入框中的结束语立即拒绝同批剩余调用，并让下一次模型调用只做总结。"""

    controller = ClarificationStopController()
    hooks = HookRegistry()
    executed: list[str] = []
    hooks.register("PreToolUse", lambda call: executed.append(call.name))
    hooks.register("ClarificationAnswered", controller.observe_answer_event)
    registry = build_default_registry(
        StoppingPresenter(),
        hooks.trigger,
        tmp_path,
    )
    executor = ToolExecutor(registry, hooks.trigger)
    responses: list[tuple[ModelBlock, ...]] = [
        (
            tool_call("clarify", "request_clarification", clarification("还需要确认权限吗？")),
            tool_call("must_not_run", "get_spec", {}),
        ),
        (TextBlock(text="已停止澄清，以下是当前总结。"),),
    ]
    client = ScriptedClient(responses)
    monkeypatch.setattr(agent, "CLIENT", client)
    monkeypatch.setattr(agent, "HOOKS", hooks)
    monkeypatch.setattr(agent, "TOOL_REGISTRY", registry)
    monkeypatch.setattr(agent, "TOOL_EXECUTOR", executor)
    history: list[dict[str, Any]] = [{"role": "user", "content": "继续完善需求"}]

    stop_reason = agent.agent_loop(history, stop_controller=controller)

    assert stop_reason == "model_complete"
    assert executed == ["request_clarification"]
    assert len(client.exposed_tools[0]) == 8
    assert client.exposed_tools[1] == ()
    assert "本轮禁止调用工具" in history[2]["content"][1]["content"]
    assert history[-1]["content"][0]["text"] == "已停止澄清，以下是当前总结。"

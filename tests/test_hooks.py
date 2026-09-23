"""默认 Hook 装配行为测试。"""

from specpilot.runtime.hooks import build_default_hooks


def test_default_hooks_do_not_limit_outer_conversation_turns() -> None:
    """任意长度的 CLI 历史都不会被旧的多轮对话预算截断。"""

    hooks = build_default_hooks("D:/example")
    messages = [{"role": "user", "content": f"第 {index} 轮"} for index in range(100)]

    result = hooks.trigger("UserPromptSubmit", messages, "继续对话")

    assert result is None


def test_default_hooks_report_events_through_injected_sink() -> None:
    """默认 Hook 经由前端事件出口报告状态，不直接绑定标准输出。"""

    events: list[str] = []
    hooks = build_default_hooks("D:/example", events.append)

    hooks.trigger("UserPromptSubmit", [], "继续对话")
    hooks.trigger("Stop", [])

    assert events == ["工作目录：D:/example", "本轮结束，共包含 0 个工具结果。"]

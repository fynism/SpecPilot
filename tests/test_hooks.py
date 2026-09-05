"""默认 Hook 装配行为测试。"""

from specpilot.hooks import build_default_hooks


def test_default_hooks_do_not_limit_outer_conversation_turns() -> None:
    """任意长度的 CLI 历史都不会被旧的多轮对话预算截断。"""

    hooks = build_default_hooks("D:/example")
    messages = [{"role": "user", "content": f"第 {index} 轮"} for index in range(100)]

    result = hooks.trigger("UserPromptSubmit", messages, "继续对话")

    assert result is None

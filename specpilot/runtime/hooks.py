"""提供 Agent 生命周期事件的注册、分发和默认 Hook。

当前职责：
    让日志、权限检查、轮次限制和统计等横切逻辑围绕 Agent Loop 插拔，而不是硬编码
    进模型调用或工具实现中。

后续扩展：
    可以增加类型化事件、Hook 优先级、异步 Hook、异常隔离和审计事件；还可为 Skill
    提供受控的 Hook 注册入口。能够阻断执行的 Hook 必须与纯观察 Hook 明确区分。
"""

from collections.abc import Callable
from typing import Any

from specpilot.config import WORKSPACE_ROOT
from specpilot.tooling.contracts import ToolCall

Hook = Callable[..., Any]


class HookRegistry:
    """保存事件与回调的映射，并按注册顺序执行回调。"""

    def __init__(self) -> None:
        """创建仅包含受支持事件、尚未注册回调的 Hook 注册表。"""

        # 显式声明支持的事件，拼错事件名时会立即暴露，而不是静默创建新事件。
        self._hooks: dict[str, list[Hook]] = {
            "UserPromptSubmit": [],
            "PreToolUse": [],
            "PostToolUse": [],
            "Stop": [],
            "ClarificationRequested": [],
            "ClarificationAnswered": [],
            "ClarificationCancelled": [],
        }

    def register(self, event: str, callback: Hook) -> None:
        """把回调追加到指定事件，保持注册顺序即执行顺序。"""
        self._hooks[event].append(callback)

    def trigger(self, event: str, *args: Any) -> Any:
        """触发事件；首个非 ``None`` 返回值会短路后续 Hook。"""

        # 非 None 代表“拦截或给出控制信号”，这是当前简单 Hook 协议的核心约定。
        for callback in self._hooks[event]:
            result = callback(*args)
            if result is not None:
                return result
        return None


def build_default_hooks(
    workspace_root: str = str(WORKSPACE_ROOT),
    event_sink: Callable[[str], None] = print,
) -> HookRegistry:
    """装配默认 Hook，并集中体现它们的执行顺序。"""

    # 装配与 Hook 定义分离，未来测试或其他前端可创建不同的 Hook 组合。
    hooks = HookRegistry()

    def show_workspace(messages: list[dict[str, Any]], query: str) -> None:
        """显示本次运行绑定的目标仓库。"""

        event_sink(f"工作目录：{workspace_root}")

    hooks.register("UserPromptSubmit", show_workspace)

    def report_tool_start(block: ToolCall) -> None:
        """向当前前端报告工具开始，但不暴露完整参数。"""

        event_sink(f"正在调用工具：{block.name}")

    def report_large_output(block: ToolCall, output: str) -> None:
        """只在工具结果异常大时报告风险。"""

        if len(str(output)) > 100000:
            event_sink(f"工具结果较大：{block.name}")

    def report_stop(messages: list[dict[str, Any]]) -> None:
        """在停止时报告本 Session 使用过的工具结果数量。"""

        tool_count = 0
        for message in messages:
            content = message.get("content")
            if not isinstance(content, list):
                continue
            tool_count += sum(
                1
                for block in content
                if isinstance(block, dict) and block.get("type") == "tool_result"
            )
        event_sink(f"本轮结束，共包含 {tool_count} 个工具结果。")

    hooks.register("PreToolUse", report_tool_start)
    hooks.register("PostToolUse", report_large_output)
    hooks.register("Stop", report_stop)
    return hooks

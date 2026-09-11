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
from specpilot.tools.models import ToolCall

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


def log_hook(block: ToolCall) -> None:
    """在工具执行前输出简洁日志，不记录可能敏感的完整参数。"""
    print(f"[HOOK] {block.name}(...)")


def large_output_hook(block: ToolCall, output: str) -> None:
    """提醒超大工具结果，避免上下文成本和可读性在无感知下恶化。"""
    if len(str(output)) > 100000:
        print(f"[HOOK] ⚠ Large output from {block.name}")


def summary_hook(messages: list[dict[str, Any]]) -> None:
    """Agent 停止前统计历史中的工具结果数量。"""
    tool_count = 0
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        tool_count += sum(
            1 for block in content if isinstance(block, dict) and block.get("type") == "tool_result"
        )
    print(f"\033[90m[HOOK] Stop: session used {tool_count} tool calls\033[0m")


def build_default_hooks(workspace_root: str = str(WORKSPACE_ROOT)) -> HookRegistry:
    """装配默认 Hook，并集中体现它们的执行顺序。"""

    # 装配与 Hook 定义分离，未来测试或其他前端可创建不同的 Hook 组合。
    hooks = HookRegistry()

    def show_workspace(messages: list[dict[str, Any]], query: str) -> None:
        """显示本次运行绑定的目标仓库。"""

        print(f"\033[90m[HOOK] UserPromptSubmit: working in {workspace_root}\033[0m")

    hooks.register("UserPromptSubmit", show_workspace)
    hooks.register("PreToolUse", log_hook)
    hooks.register("PostToolUse", large_output_hook)
    hooks.register("Stop", summary_hook)
    return hooks

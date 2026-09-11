"""实现统一的工具校验、Hook 与异常转换执行管线。"""

from collections.abc import Callable
from typing import Any

from pydantic import ValidationError

from specpilot.tooling.contracts import ToolCall
from specpilot.tooling.registry import ToolRegistry


class ToolExecutor:
    """让每次工具调用统一经过查找、校验、Hook 和异常处理。"""

    def __init__(self, registry: ToolRegistry, hook_dispatcher: Callable[..., Any]) -> None:
        """注入工具注册表和 Hook 分发器，建立统一执行管线。"""

        # 通过注入 Hook 分发函数保持执行器独立，测试时可以替换为空实现或记录器。
        self._registry = registry
        self._trigger_hooks = hook_dispatcher

    def execute(self, name: str, tool_input: dict[str, Any]) -> str:
        """执行一次模型请求的工具调用，并始终向模型返回字符串结果。"""

        # 先解析注册信息，再校验输入，保证非法参数不会进入工具处理函数。
        try:
            tool = self._registry.get(name)
        except KeyError as exc:
            return f"Error: {exc.args[0]}"

        try:
            validated_input = tool.spec.input_model.model_validate(tool_input)
        except ValidationError as exc:
            details = "; ".join(
                f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
                for error in exc.errors(include_url=False)
            )
            return f"Error: invalid input for tool {name!r}: {details}"

        # Hook 接收规范化后的参数，避免每个 Hook 重复理解原始模型输出。
        call = ToolCall(name=name, input=validated_input.model_dump())
        blocked = self._trigger_hooks("PreToolUse", call)
        if blocked is not None:
            return str(blocked)

        # 工具异常被转换为可反馈给模型的结果，使 Agent 有机会修正调用或解释失败。
        try:
            output = str(tool.handler(validated_input))
        except Exception as exc:
            output = f"Error: tool {name!r} failed: {type(exc).__name__}: {exc}"

        self._trigger_hooks("PostToolUse", call, output)
        return output

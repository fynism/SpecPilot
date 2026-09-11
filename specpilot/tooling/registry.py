"""维护模型可用工具的单一注册表。"""

from collections.abc import Callable
from typing import Any

from specpilot.tooling.contracts import RegisteredTool, ToolSpec


class ToolRegistry:
    """工具声明和处理函数的单一注册中心。"""

    def __init__(self) -> None:
        """创建相互隔离的空工具注册表。"""

        self._tools: dict[str, RegisteredTool] = {}

    def register(self, spec: ToolSpec, handler: Callable[[Any], str]) -> None:
        """注册一个工具；拒绝重名以避免处理函数被静默覆盖。"""

        if spec.name in self._tools:
            raise ValueError(f"Tool {spec.name!r} is already registered")
        self._tools[spec.name] = RegisteredTool(spec=spec, handler=handler)

    def get(self, name: str) -> RegisteredTool:
        """按名称获取工具，并把内部 KeyError 转成更清晰的未知工具错误。"""

        try:
            return self._tools[name]
        except KeyError as exc:
            raise KeyError(f"Unknown tool {name!r}") from exc

    def tool_specs(self) -> tuple[ToolSpec, ...]:
        """返回当前按注册顺序开放的供应商无关工具声明。"""

        return tuple(tool.spec for tool in self._tools.values())

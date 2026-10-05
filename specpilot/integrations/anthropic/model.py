"""把 Anthropic SDK 适配到运行时模型接口。"""

from typing import Any, cast

from anthropic import Anthropic

from specpilot.runtime.model import Message, ModelBlock, TextBlock, ToolUseBlock
from specpilot.tooling.contracts import ToolSpec


class AnthropicModelClient:
    """把 Anthropic SDK 响应规范化为内部消息块。"""

    def __init__(self, api_key: str, model: str, base_url: str | None = None) -> None:
        """创建客户端，并保存本次运行使用的模型标识。"""

        options: dict[str, Any] = {"api_key": api_key}
        if base_url:
            options["base_url"] = base_url
        self._client = Anthropic(**options)
        self._model = model

    def create_message(
        self,
        messages: list[Message],
        tools: tuple[ToolSpec, ...],
        system: str,
        max_tokens: int,
    ) -> tuple[ModelBlock, ...]:
        """调用供应商 SDK，并只保留运行时实际支持的响应块。"""

        # SDK 的 TypedDict 与内部可变历史在类型层面并不协变；不安全转换只留在适配层。
        # 外部格式只在 Adapter 中生成，Tooling 和 Agent Loop 不依赖供应商字段。
        anthropic_tools = [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_model.model_json_schema(),
            }
            for tool in tools
        ]
        request: dict[str, Any] = {
            "model": self._model,
            "system": system,
            "messages": cast(Any, messages),
            "max_tokens": max_tokens,
        }
        # 最终总结轮通过完全省略 tools 参数形成供应商侧硬边界，不能只传空描述后依赖
        # 模型自行遵守“不要调用工具”的自然语言要求。
        if anthropic_tools:
            request["tools"] = anthropic_tools
        response = self._client.messages.create(**request)
        normalized: list[ModelBlock] = []
        for block in response.content:
            if block.type == "text":
                normalized.append(TextBlock(text=block.text))
            elif block.type == "tool_use":
                normalized.append(
                    ToolUseBlock(id=block.id, name=block.name, input=dict(block.input))
                )
        return tuple(normalized)

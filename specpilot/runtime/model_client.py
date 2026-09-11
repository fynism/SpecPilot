"""隔离模型供应商 SDK，并提供 Agent Loop 使用的最小消息模型。"""

from typing import Any, Literal, Protocol, cast

from anthropic import Anthropic
from pydantic import BaseModel, ConfigDict


class TextBlock(BaseModel):
    """模型返回的普通文本。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    type: Literal["text"] = "text"
    text: str


class ToolUseBlock(BaseModel):
    """模型请求执行的一次工具调用。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict[str, Any]


ModelBlock = TextBlock | ToolUseBlock
Message = dict[str, Any]


class ModelClient(Protocol):
    """Agent Loop 所需的供应商无关模型接口。"""

    def create_message(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]],
        system: str,
        max_tokens: int,
    ) -> tuple[ModelBlock, ...]:
        """根据当前上下文返回下一批文本或工具调用块。"""


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
        tools: list[dict[str, Any]],
        system: str,
        max_tokens: int,
    ) -> tuple[ModelBlock, ...]:
        """调用供应商 SDK，并只保留运行时实际支持的响应块。"""

        # SDK 的 TypedDict 与内部可变历史在类型层面并不协变；不安全转换只留在适配层。
        response = self._client.messages.create(
            model=self._model,
            system=system,
            messages=cast(Any, messages),
            tools=cast(Any, tools),
            max_tokens=max_tokens,
        )
        normalized: list[ModelBlock] = []
        for block in response.content:
            if block.type == "text":
                normalized.append(TextBlock(text=block.text))
            elif block.type == "tool_use":
                normalized.append(
                    ToolUseBlock(id=block.id, name=block.name, input=dict(block.input))
                )
        return tuple(normalized)

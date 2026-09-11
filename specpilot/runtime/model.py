"""定义 Agent Loop 使用的供应商无关模型接口与消息块。"""

from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict

from specpilot.tooling.contracts import ToolSpec


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
        tools: tuple[ToolSpec, ...],
        system: str,
        max_tokens: int,
    ) -> tuple[ModelBlock, ...]:
        """根据当前上下文返回下一批文本或工具调用块。"""

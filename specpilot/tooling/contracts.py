"""定义所有 Tool 共享的输入、声明、注册项和调用契约。"""

from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ToolInput(BaseModel):
    """所有工具参数的严格基类。

    禁止额外字段并关闭隐式类型转换，防止模型拼错参数时仍被静默接受。
    """

    model_config = ConfigDict(extra="forbid", strict=True)


class EmptyInput(ToolInput):
    """表示无需参数、但仍要求模型传入空对象的工具输入。"""


class ToolSpec(BaseModel):
    """模型可见的工具说明，以及执行前使用的输入类型。"""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1)
    input_model: type[ToolInput]


class RegisteredTool(BaseModel):
    """把模型可见的工具契约与实际 Python 处理函数绑定。"""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    spec: ToolSpec
    handler: Callable[[Any], str]


class ToolCall(BaseModel):
    """传递给 Hook 的、已经过输入校验的统一工具调用。"""

    model_config = ConfigDict(frozen=True)

    name: str
    input: dict[str, Any]

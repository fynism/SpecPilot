"""定义工具运行时共享的结构化数据模型。

当前职责：
    使用 Pydantic 描述工具输入、模型可见的工具声明、已注册工具和规范化工具调用，
    让模型输出在进入执行器之前经过统一校验。

后续扩展：
    可以加入 Spec、澄清问题、审批请求、会话状态和工具结果等领域模型。此模块只放
    跨模块共享的数据契约，避免混入文件读写或网络调用。
"""

from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ToolInput(BaseModel):
    """所有工具参数的严格基类。

    禁止额外字段并关闭隐式类型转换，防止模型拼错参数时仍被静默接受。
    """

    model_config = ConfigDict(extra="forbid", strict=True)


class EmptyInput(ToolInput):
    """表示无需参数的工具，同时仍生成明确的空对象 JSON Schema。"""

    pass


class SearchNotesInput(ToolInput):
    """搜索笔记工具的参数，要求查询文本不能为空。"""

    query: str = Field(min_length=1, description="Text to search for in Markdown notes.")


class ReadNotesInput(ToolInput):
    """读取笔记工具的参数，路径必须相对于笔记目录。"""

    path: str = Field(min_length=1, description="Note path relative to the notes directory.")


class PwshInput(ToolInput):
    """PowerShell 工具的参数，具体命令还需通过安全策略检查。"""

    command: str = Field(min_length=1, description="PowerShell command to execute.")


class ToolSpec(BaseModel):
    """模型可见的工具说明，以及执行前使用的输入类型。"""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=1)
    input_model: type[ToolInput]

    def to_anthropic(self) -> dict[str, Any]:
        """把内部工具定义转换为 Anthropic API 接受的声明格式。"""

        # Schema 直接由输入模型生成，模型提示与运行时校验因此共享同一个事实源。
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_model.model_json_schema(),
        }


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

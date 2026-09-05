"""定义工具运行时共享的结构化数据模型。

当前职责：
    使用 Pydantic 描述工具输入、模型可见的工具声明、已注册工具和规范化工具调用，
    让模型输出在进入执行器之前经过统一校验。

后续扩展：
    可以加入 Spec、澄清问题、审批请求、会话状态和工具结果等领域模型。此模块只放
    跨模块共享的数据契约，避免混入文件读写或网络调用。
"""

from collections.abc import Callable
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ToolInput(BaseModel):
    """所有工具参数的严格基类。

    禁止额外字段并关闭隐式类型转换，防止模型拼错参数时仍被静默接受。
    """

    model_config = ConfigDict(extra="forbid", strict=True)


class ClarificationOption(BaseModel):
    """A single user-selectable answer and its most important consequence."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)
    label: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=300)


class RequestClarificationInput(ToolInput):
    """Strict model-generated input for a requirement clarification request."""

    question: str = Field(min_length=1, max_length=500)
    reason: str = Field(min_length=1, max_length=500)
    options: list[ClarificationOption] = Field(min_length=2, max_length=5)
    recommended_option_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)
    recommendation_reason: str = Field(min_length=1, max_length=500)
    allow_custom_answer: bool = True

    @model_validator(mode="after")
    def validate_option_references(self) -> "RequestClarificationInput":
        """Require unique option IDs and a recommendation that references an option."""

        option_ids = [option.id for option in self.options]
        if len(option_ids) != len(set(option_ids)):
            raise ValueError("clarification option IDs must be unique")
        if self.recommended_option_id not in option_ids:
            raise ValueError("recommended_option_id must reference an existing option")
        return self


class ClarificationRequest(RequestClarificationInput):
    """A validated clarification request with a runtime-assigned stable ID."""

    request_id: str = Field(
        default_factory=lambda: f"Q-{uuid4().hex[:12]}",
        pattern=r"^Q-[0-9a-f]{12}$",
    )


class ClarificationAnswer(BaseModel):
    """A user-confirmed option or custom answer returned to the model."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    request_id: str
    selected_option_id: str | None = None
    custom_answer: str | None = Field(default=None, min_length=1, max_length=1000)
    source: Literal["user"] = "user"

    @model_validator(mode="after")
    def validate_exactly_one_answer(self) -> "ClarificationAnswer":
        """Reject missing or ambiguous answers."""

        has_option = self.selected_option_id is not None
        has_custom = self.custom_answer is not None
        if has_option == has_custom:
            raise ValueError("provide exactly one of selected_option_id or custom_answer")
        return self


class ClarificationOutcome(BaseModel):
    """Structured tool result for either an answered or cancelled request."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    status: Literal["answered", "cancelled"]
    request_id: str
    answer: ClarificationAnswer | None = None

    @model_validator(mode="after")
    def validate_status_payload(self) -> "ClarificationOutcome":
        """Keep status and answer presence consistent."""

        if (self.status == "answered") != (self.answer is not None):
            raise ValueError("answered outcomes require an answer; cancelled outcomes forbid one")
        return self


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

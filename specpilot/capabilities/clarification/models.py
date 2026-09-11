"""定义结构化需求澄清使用的数据契约。"""

from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specpilot.tooling.contracts import ToolInput


class ClarificationOption(BaseModel):
    """一个可供用户选择的答案及其最重要后果。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)
    label: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=300)


class RequestClarificationInput(ToolInput):
    """模型生成的一次严格需求澄清输入。"""

    question: str = Field(min_length=1, max_length=500)
    reason: str = Field(min_length=1, max_length=500)
    options: list[ClarificationOption] = Field(min_length=2, max_length=5)
    recommended_option_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)
    recommendation_reason: str = Field(min_length=1, max_length=500)
    allow_custom_answer: bool = True

    @model_validator(mode="after")
    def validate_option_references(self) -> "RequestClarificationInput":
        """要求选项 ID 唯一，并保证推荐项确实存在。"""

        option_ids = [option.id for option in self.options]
        if len(option_ids) != len(set(option_ids)):
            raise ValueError("clarification option IDs must be unique")
        if self.recommended_option_id not in option_ids:
            raise ValueError("recommended_option_id must reference an existing option")
        return self


class ClarificationRequest(RequestClarificationInput):
    """带有运行时稳定 ID、已经校验的澄清请求。"""

    request_id: str = Field(
        default_factory=lambda: f"Q-{uuid4().hex[:12]}",
        pattern=r"^Q-[0-9a-f]{12}$",
    )


class ClarificationAnswer(BaseModel):
    """由用户确认的选项或自定义答案。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    request_id: str
    selected_option_id: str | None = None
    custom_answer: str | None = Field(default=None, min_length=1, max_length=1000)
    source: Literal["user"] = "user"

    @model_validator(mode="after")
    def validate_exactly_one_answer(self) -> "ClarificationAnswer":
        """拒绝缺少答案或同时包含两种答案的结果。"""

        has_option = self.selected_option_id is not None
        has_custom = self.custom_answer is not None
        if has_option == has_custom:
            raise ValueError("provide exactly one of selected_option_id or custom_answer")
        return self


class ClarificationOutcome(BaseModel):
    """已回答或已取消的结构化工具结果。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    status: Literal["answered", "cancelled"]
    request_id: str
    answer: ClarificationAnswer | None = None

    @model_validator(mode="after")
    def validate_status_payload(self) -> "ClarificationOutcome":
        """保持状态与答案是否存在相一致。"""

        if (self.status == "answered") != (self.answer is not None):
            raise ValueError("answered outcomes require an answer; cancelled outcomes forbid one")
        return self

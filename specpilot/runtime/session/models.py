"""定义对话、Context 与 Spec 隔离所需的 Session 状态。"""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from specpilot.capabilities.spec.models import Specification, create_specification

SESSION_SCHEMA_VERSION: Literal[1] = 1
SessionStatus = Literal[
    "waiting_for_user",
    "running",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
]


class SessionRecord(BaseModel):
    """一个可原子保存的本地对话及其独占 Spec。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal[1] = SESSION_SCHEMA_VERSION
    session_id: str = Field(pattern=r"^SS-[0-9a-f]{12}$")
    title: str = Field(min_length=1, max_length=200)
    status: SessionStatus = "waiting_for_user"
    active_request: str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    spec_id: str
    spec_versions: tuple[Specification, ...] = Field(min_length=1)
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def validate_state_consistency(self) -> "SessionRecord":
        """保证恢复边界、Spec 身份和版本历史内部一致。"""

        if not self.title.strip():
            raise ValueError("Session 标题不能为空")
        if self.updated_at < self.created_at:
            raise ValueError("Session 更新时间不能早于创建时间")
        if self.status in {"waiting_for_user", "completed", "failed", "cancelled"} and (
            self.active_request is not None
        ):
            raise ValueError("非运行状态的 Session 不能保留 active_request")
        if self.status in {"running", "interrupted"} and not self.active_request:
            raise ValueError("运行中或已中断的 Session 必须保留 active_request")

        if any(spec.spec_id != self.spec_id for spec in self.spec_versions):
            raise ValueError("Session 中的全部 Spec 版本必须使用同一个 spec_id")
        versions = tuple(spec.version for spec in self.spec_versions)
        expected_versions = tuple(range(1, len(self.spec_versions) + 1))
        if versions != expected_versions:
            raise ValueError("Session 中的 Spec 版本必须从 1 开始连续递增")

        for message in self.messages:
            if set(message) != {"role", "content"}:
                raise ValueError("Session 消息必须只包含 role 和 content")
            if message["role"] not in {"user", "assistant"}:
                raise ValueError("Session 消息 role 必须是 user 或 assistant")
            content = message["content"]
            if not isinstance(content, (str, list)):
                raise ValueError("Session 消息 content 必须是字符串或内容块列表")
            if isinstance(content, list) and not all(isinstance(block, dict) for block in content):
                raise ValueError("Session 消息内容块必须是对象")
        return self


def create_session_record(
    title: str = "新对话",
    *,
    clock: Callable[[], datetime] | None = None,
    id_factory: Callable[[], str] | None = None,
) -> SessionRecord:
    """创建带独立空白 Spec 的新 Session。"""

    normalized_title = title.strip()
    if not normalized_title:
        raise ValueError("Session 标题不能为空")
    runtime_clock = clock or (lambda: datetime.now(UTC))
    timestamp = runtime_clock()
    session_id = id_factory() if id_factory is not None else f"SS-{uuid4().hex[:12]}"
    spec = create_specification(normalized_title, now=timestamp)
    return SessionRecord(
        session_id=session_id,
        title=normalized_title,
        spec_id=spec.spec_id,
        spec_versions=(spec,),
        created_at=timestamp,
        updated_at=timestamp,
    )

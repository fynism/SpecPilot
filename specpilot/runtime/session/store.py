"""定义 Session 持久化端口及明确的存储异常。"""

from typing import Protocol

from specpilot.runtime.session.models import SessionRecord


class SessionNotFoundError(LookupError):
    """表示请求的 Session 不存在于当前 worktree。"""


class SessionStorageError(RuntimeError):
    """表示本地 Session 数据损坏、版本不兼容或无法安全写入。"""


class SessionStore(Protocol):
    """持久化多个 Session 并记录当前活动项的最小接口。"""

    def save(self, session: SessionRecord) -> None:
        """原子保存一个完整 Session 快照。"""

    def load(self, session_id: str) -> SessionRecord:
        """按稳定 ID 读取 Session。"""

    def list_sessions(self) -> tuple[SessionRecord, ...]:
        """按最近更新时间返回当前 worktree 的 Session。"""

    def active_session_id(self) -> str | None:
        """返回上次活动的 Session ID。"""

    def set_active(self, session_id: str) -> None:
        """把已存在的 Session 标记为当前活动项。"""

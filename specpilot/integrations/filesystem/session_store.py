"""把当前 worktree 的 Session 作为原子 JSON 快照保存在本地。"""

import os
import re
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, ValidationError, model_validator

from specpilot.runtime.session.models import SESSION_SCHEMA_VERSION, SessionRecord
from specpilot.runtime.session.store import SessionNotFoundError, SessionStorageError

SESSION_ID_PATTERN = re.compile(r"^SS-[0-9a-f]{12}$")


class _SessionIndex(BaseModel):
    """记录当前 worktree 中已知 Session 与上次活动项。"""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: int = SESSION_SCHEMA_VERSION
    active_session_id: str | None = None
    session_ids: tuple[str, ...] = ()

    @model_validator(mode="after")
    def validate_active_session(self) -> "_SessionIndex":
        """保证活动 Session 一定存在于索引中。"""

        if self.schema_version != SESSION_SCHEMA_VERSION:
            raise ValueError(f"不支持的 Session 索引版本：{self.schema_version}")
        if len(self.session_ids) != len(set(self.session_ids)):
            raise ValueError("Session 索引包含重复 ID")
        if self.active_session_id is not None and self.active_session_id not in self.session_ids:
            raise ValueError("活动 Session 不在索引中")
        return self


class LocalSessionStore:
    """在一个 worktree 边界内保存互相隔离的 Session。"""

    def __init__(self, workspace_root: Path) -> None:
        """绑定工作目录；不同 worktree 会自然使用不同存储根。"""

        self._workspace_root = workspace_root.resolve()
        if not self._workspace_root.is_dir():
            raise ValueError(f"工作目录不存在或不是目录：{self._workspace_root}")
        self._root = (self._workspace_root / ".specpilot" / "sessions").resolve()
        # 本地状态必须真正属于当前 worktree；已有符号链接不能把写入位置重定向到外部。
        if not self._root.is_relative_to(self._workspace_root):
            raise ValueError("Session 存储目录解析到了当前 worktree 之外")
        self._index_path = self._root / "index.json"

    def save(self, session: SessionRecord) -> None:
        """原子保存完整 Session，并在首次保存时加入索引。"""

        # model_copy 不会自动重新运行全部校验；持久化边界必须复验，不能把无效恢复点写盘。
        try:
            validated = SessionRecord.model_validate(session.model_dump())
        except ValidationError as exc:
            raise SessionStorageError("拒绝保存不一致的 Session 快照") from exc
        path = self._session_path(validated.session_id)
        self._atomic_write(path, f"{validated.model_dump_json(indent=2)}\n")

        index = self._load_index()
        if validated.session_id not in index.session_ids:
            updated = index.model_copy(
                update={"session_ids": (*index.session_ids, validated.session_id)}
            )
            self._write_index(updated)

    def load(self, session_id: str) -> SessionRecord:
        """读取并严格校验一个 Session 快照。"""

        path = self._session_path(session_id)
        if not path.is_file():
            raise SessionNotFoundError(f"Session 不存在：{session_id}")
        try:
            return SessionRecord.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError, ValueError) as exc:
            raise SessionStorageError(f"Session 数据损坏或不兼容：{session_id}") from exc

    def list_sessions(self) -> tuple[SessionRecord, ...]:
        """按最近更新时间列出索引中的 Session。"""

        sessions = [self.load(session_id) for session_id in self._load_index().session_ids]
        return tuple(sorted(sessions, key=lambda item: item.updated_at, reverse=True))

    def active_session_id(self) -> str | None:
        """返回上次活动 Session ID。"""

        return self._load_index().active_session_id

    def set_active(self, session_id: str) -> None:
        """仅允许把索引中真实存在的 Session 设为活动项。"""

        self.load(session_id)
        index = self._load_index()
        if session_id not in index.session_ids:
            raise SessionNotFoundError(f"Session 不在当前 worktree 索引中：{session_id}")
        self._write_index(index.model_copy(update={"active_session_id": session_id}))

    def _session_path(self, session_id: str) -> Path:
        """把受校验的 Session ID 解析到固定存储根。"""

        if not SESSION_ID_PATTERN.fullmatch(session_id):
            raise SessionNotFoundError(f"Session ID 格式无效：{session_id}")
        path = (self._root / session_id / "session.json").resolve()
        # 即使未来 ID 规则变化，也必须复验最终路径，不能让用户输入逃逸 worktree 边界。
        if not path.is_relative_to(self._root.resolve()):
            raise SessionStorageError("Session 路径解析到了当前 worktree 之外")
        return path

    def _load_index(self) -> _SessionIndex:
        """读取索引；首次运行时返回空索引。"""

        if not self._index_path.exists():
            return _SessionIndex()
        try:
            return _SessionIndex.model_validate_json(self._index_path.read_text(encoding="utf-8"))
        except (OSError, ValidationError, ValueError) as exc:
            raise SessionStorageError("Session 索引损坏或版本不兼容") from exc

    def _write_index(self, index: _SessionIndex) -> None:
        """原子保存 Session 索引。"""

        try:
            validated = _SessionIndex.model_validate(index.model_dump())
        except ValidationError as exc:
            raise SessionStorageError("拒绝保存不一致的 Session 索引") from exc
        self._atomic_write(self._index_path, f"{validated.model_dump_json(indent=2)}\n")

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        """使用同目录临时文件加原子替换，避免暴露半写 JSON。"""

        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            temporary.write_text(content, encoding="utf-8", newline="\n")
            os.replace(temporary, path)
        except OSError as exc:
            raise SessionStorageError(f"无法安全写入 Session 文件：{path}") from exc
        finally:
            temporary.unlink(missing_ok=True)

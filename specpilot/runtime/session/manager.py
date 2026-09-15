"""协调 Session 生命周期、Agent Loop 恢复边界与 Spec 隔离。"""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from specpilot.capabilities.spec.models import Specification
from specpilot.capabilities.spec.operations import SpecToolService
from specpilot.capabilities.spec.store import InMemorySpecStore
from specpilot.runtime.session.models import SessionRecord, create_session_record
from specpilot.runtime.session.store import SessionStore


class SessionManager:
    """管理当前活动 Session，并只在完整 Agent Loop 边界切换。"""

    def __init__(
        self,
        store: SessionStore,
        *,
        clock: Callable[[], datetime] | None = None,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        """注入持久化端口、时钟和可测试的 Session ID 生成器。"""

        self._store = store
        self._clock = clock or (lambda: datetime.now(UTC))
        self._id_factory = id_factory
        self._current: SessionRecord | None = None
        self._spec_store: InMemorySpecStore | None = None

    @property
    def current(self) -> SessionRecord:
        """返回当前内存状态的隔离快照。"""

        self._require_started()
        assert self._current is not None
        return self._snapshot(self._current).model_copy(deep=True)

    @property
    def messages(self) -> list[dict[str, Any]]:
        """返回供当前 Agent Loop 追加内容的消息容器。"""

        self._require_started()
        assert self._current is not None
        return self._current.messages

    @property
    def spec_tools(self) -> SpecToolService:
        """返回只绑定当前 Session Spec 的工具服务。"""

        self._require_started()
        assert self._current is not None
        assert self._spec_store is not None
        return SpecToolService(self._spec_store, self._current.spec_id, self._clock)

    def start(self) -> SessionRecord:
        """恢复上次活动 Session；首次使用时创建一个新 Session。"""

        active_id = self._store.active_session_id()
        if active_id is None:
            return self.create()

        session = self._store.load(active_id)
        if session.status == "running":
            # 进程退出时仍处于 running，说明没有形成完整轮次保存点。恢复时只标记中断，
            # 不能自动重放可能已经产生副作用的模型或工具调用。
            session = session.model_copy(
                update={"status": "interrupted", "updated_at": self._clock()}
            )
            self._store.save(session)
        self._activate(session)
        return self.current

    def create(self, title: str = "新对话") -> SessionRecord:
        """创建并切换到一个带独立 Spec 的 Session。"""

        session = create_session_record(
            title,
            clock=self._clock,
            id_factory=self._id_factory,
        )
        self._store.save(session)
        self._store.set_active(session.session_id)
        self._activate(session)
        return self.current

    def switch(self, session_id: str) -> SessionRecord:
        """在 Agent Loop 之外切换到一个已保存 Session。"""

        self._require_started()
        assert self._current is not None
        if self._current.status == "running":
            raise RuntimeError("Agent Loop 运行中不能切换 Session")
        session = self._store.load(session_id)
        if session.status == "running":
            session = session.model_copy(
                update={"status": "interrupted", "updated_at": self._clock()}
            )
            self._store.save(session)
        self._store.set_active(session.session_id)
        self._activate(session)
        return self.current

    def rename(self, title: str) -> SessionRecord:
        """修改当前 Session 的展示标题，不改写 Spec 标题。"""

        normalized_title = title.strip()
        if not normalized_title:
            raise ValueError("Session 标题不能为空")
        self._require_started()
        assert self._current is not None
        self._current = self._current.model_copy(
            update={"title": normalized_title, "updated_at": self._clock()}
        )
        self._persist_current()
        return self.current

    def list_sessions(self) -> tuple[SessionRecord, ...]:
        """列出当前 worktree 保存的全部 Session。"""

        return self._store.list_sessions()

    def begin_turn(self, request: str) -> None:
        """保存用户请求并把当前 Session 标为运行中。"""

        normalized_request = request.strip()
        if not normalized_request:
            raise ValueError("用户请求不能为空")
        self._require_started()
        assert self._current is not None
        if self._current.status not in {"waiting_for_user", "interrupted"}:
            raise RuntimeError(f"当前 Session 状态不允许开始新轮次：{self._current.status}")

        messages = [*self._current.messages, {"role": "user", "content": request}]
        self._current = self._current.model_copy(
            update={
                "status": "running",
                "active_request": request,
                "messages": messages,
                "updated_at": self._clock(),
            }
        )
        # 先记录 running 与当前请求，异常退出后才能明确提示中断，而不是伪装成完整恢复。
        self._persist_current()

    def complete_turn(self) -> None:
        """在 Agent Loop 返回后保存一个可恢复的完整轮次。"""

        self._require_started()
        assert self._current is not None
        self._current = self._current.model_copy(
            update={
                "status": "waiting_for_user",
                "active_request": None,
                "updated_at": self._clock(),
            }
        )
        self._persist_current()

    def interrupt_turn(self) -> None:
        """回退到本轮开始时的稳定快照，并把未完成轮次标为中断。"""

        self._require_started()
        assert self._current is not None
        if self._current.status != "running":
            return
        # Agent Loop 内存中可能只追加了 assistant(tool_use)，尚未形成对应 tool_result。
        # 中断时重新读取 begin_turn 保存的稳定快照，避免持久化供应商无法接受的孤立调用。
        stable = self._store.load(self._current.session_id)
        interrupted = stable.model_copy(
            update={"status": "interrupted", "updated_at": self._clock()}
        )
        self._store.save(interrupted)
        self._activate(interrupted)

    def current_spec(self) -> Specification:
        """返回当前 Session 的最新结构化 Spec。"""

        return self.spec_tools.current_spec()

    def _activate(self, session: SessionRecord) -> None:
        """从持久化快照重建当前 Session 的独立内存 Spec Store。"""

        self._current = session.model_copy(deep=True)
        self._spec_store = InMemorySpecStore.from_history(
            session.spec_versions,
            clock=self._clock,
        )

    def _snapshot(self, session: SessionRecord) -> SessionRecord:
        """把运行期间产生的最新 Spec 历史合入 Session 快照。"""

        assert self._spec_store is not None
        return session.model_copy(
            update={"spec_versions": self._spec_store.history(session.spec_id)},
            deep=True,
        )

    def _persist_current(self) -> None:
        """原子保存消息与完整 Spec 历史组成的一致快照。"""

        assert self._current is not None
        self._current = self._snapshot(self._current)
        self._store.save(self._current)

    def _require_started(self) -> None:
        """拒绝在尚未恢复或创建 Session 时访问当前状态。"""

        if self._current is None or self._spec_store is None:
            raise RuntimeError("SessionManager 尚未启动")

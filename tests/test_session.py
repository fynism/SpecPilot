"""本地持久化 Session、恢复边界与 Spec 隔离测试。"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from specpilot.capabilities.spec.operations import ApplySpecPatchInput
from specpilot.integrations.filesystem.session_store import LocalSessionStore
from specpilot.runtime.session.manager import SessionManager
from specpilot.runtime.session.models import create_session_record
from specpilot.runtime.session.store import SessionNotFoundError, SessionStorageError

NOW = datetime(2026, 9, 15, 8, 0, tzinfo=UTC)


class AdvancingClock:
    """为持久化测试提供单调且可复现的 UTC 时间。"""

    def __init__(self) -> None:
        self._current = NOW

    def __call__(self) -> datetime:
        current = self._current
        self._current += timedelta(seconds=1)
        return current


def id_factory(ids: Iterator[str]) -> Any:
    """把迭代器包装成 SessionManager 可调用的 ID 生成器。"""

    return lambda: next(ids)


def change_spec_title(manager: SessionManager, title: str) -> None:
    """通过公开 Spec 工具语义修改当前 Session 的 Spec。"""

    manager.spec_tools.apply_spec_patch(
        ApplySpecPatchInput.model_validate(
            {
                "expected_version": 1,
                "change_reason": "测试 Session 间的 Spec 隔离",
                "operations": [
                    {
                        "op": "set_spec_metadata",
                        "title": title,
                    }
                ],
            }
        )
    )


def test_sessions_persist_messages_and_isolate_specs(tmp_path: Path) -> None:
    """两个 Session 来回切换后仍各自恢复消息和 Spec。"""

    clock = AdvancingClock()
    ids = iter(("SS-000000000001", "SS-000000000002"))
    manager = SessionManager(
        LocalSessionStore(tmp_path),
        clock=clock,
        id_factory=id_factory(ids),
    )

    first = manager.start()
    manager.begin_turn("整理导出需求")
    manager.messages.append(
        {"role": "assistant", "content": [{"type": "text", "text": "先确认权限。"}]}
    )
    change_spec_title(manager, "导出功能")
    manager.complete_turn()

    second = manager.create("审计功能")
    manager.begin_turn("整理审计需求")
    manager.messages.append(
        {"role": "assistant", "content": [{"type": "text", "text": "先调查日志。"}]}
    )
    change_spec_title(manager, "审计日志")
    manager.complete_turn()

    manager.switch(first.session_id)
    assert manager.messages[0]["content"] == "整理导出需求"
    assert manager.current_spec().title == "导出功能"
    assert manager.current_spec().version == 2

    manager.switch(second.session_id)
    assert manager.messages[0]["content"] == "整理审计需求"
    assert manager.current_spec().title == "审计日志"
    assert manager.current_spec().version == 2


def test_restart_restores_last_active_session(tmp_path: Path) -> None:
    """重新创建管理器后恢复上次活动 Session 的完整轮次。"""

    clock = AdvancingClock()
    store = LocalSessionStore(tmp_path)
    manager = SessionManager(
        store,
        clock=clock,
        id_factory=lambda: "SS-000000000001",
    )
    created = manager.start()
    manager.begin_turn("保留这条消息")
    manager.messages.append(
        {"role": "assistant", "content": [{"type": "text", "text": "已经保留。"}]}
    )
    manager.complete_turn()

    restored_manager = SessionManager(store, clock=clock)
    restored = restored_manager.start()

    assert restored.session_id == created.session_id
    assert restored.status == "waiting_for_user"
    assert restored.messages == manager.current.messages


def test_restart_marks_unfinished_turn_as_interrupted_without_replay(tmp_path: Path) -> None:
    """运行中退出只标记中断并保留请求，不自动追加模型或工具结果。"""

    clock = AdvancingClock()
    store = LocalSessionStore(tmp_path)
    manager = SessionManager(
        store,
        clock=clock,
        id_factory=lambda: "SS-000000000001",
    )
    manager.start()
    manager.begin_turn("尚未完成的请求")

    restored_manager = SessionManager(store, clock=clock)
    restored = restored_manager.start()

    assert restored.status == "interrupted"
    assert restored.active_request == "尚未完成的请求"
    assert restored.messages == [{"role": "user", "content": "尚未完成的请求"}]


def test_explicit_interrupt_discards_unclosed_tool_use_and_uncommitted_spec(tmp_path: Path) -> None:
    """中断不保存孤立工具调用，也不把未完成轮次中的 Spec 修改伪装成稳定结果。"""

    clock = AdvancingClock()
    store = LocalSessionStore(tmp_path)
    manager = SessionManager(
        store,
        clock=clock,
        id_factory=lambda: "SS-000000000001",
    )
    manager.start()
    manager.begin_turn("执行到一半的请求")
    manager.messages.append(
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "tool-001",
                    "name": "get_spec",
                    "input": {},
                }
            ],
        }
    )
    change_spec_title(manager, "不应提交的标题")

    manager.interrupt_turn()

    assert manager.current.status == "interrupted"
    assert manager.messages == [{"role": "user", "content": "执行到一半的请求"}]
    assert manager.current_spec().title == "新对话"
    assert manager.current_spec().version == 1


def test_different_worktrees_use_independent_session_indexes(tmp_path: Path) -> None:
    """两个工作目录即使 ID 相同，也不会共享 Session 内容。"""

    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    first = create_session_record(
        "第一个 worktree",
        clock=lambda: NOW,
        id_factory=lambda: "SS-000000000001",
    )
    second = create_session_record(
        "第二个 worktree",
        clock=lambda: NOW,
        id_factory=lambda: "SS-000000000001",
    )

    first_store = LocalSessionStore(first_root)
    second_store = LocalSessionStore(second_root)
    first_store.save(first)
    second_store.save(second)

    assert first_store.load(first.session_id).title == "第一个 worktree"
    assert second_store.load(second.session_id).title == "第二个 worktree"


def test_corrupted_session_fails_without_becoming_empty(tmp_path: Path) -> None:
    """损坏快照必须明确失败，不能被当成新的空 Session。"""

    session = create_session_record(
        clock=lambda: NOW,
        id_factory=lambda: "SS-000000000001",
    )
    store = LocalSessionStore(tmp_path)
    store.save(session)
    session_path = tmp_path / ".specpilot" / "sessions" / session.session_id / "session.json"
    session_path.write_text("{broken", encoding="utf-8")

    with pytest.raises(SessionStorageError, match="损坏或不兼容"):
        store.load(session.session_id)


def test_invalid_message_snapshot_is_rejected_before_overwrite(tmp_path: Path) -> None:
    """持久化边界拒绝非法消息，并保留上一份有效快照。"""

    session = create_session_record(
        clock=lambda: NOW,
        id_factory=lambda: "SS-000000000001",
    )
    store = LocalSessionStore(tmp_path)
    store.save(session)
    invalid = session.model_copy(
        update={"messages": [{"role": "system", "content": "不允许持久化的消息"}]}
    )

    with pytest.raises(SessionStorageError, match="拒绝保存"):
        store.save(invalid)

    assert store.load(session.session_id).messages == []


def test_session_id_cannot_escape_storage_root(tmp_path: Path) -> None:
    """用户提供的 Session ID 不能被解释为任意文件路径。"""

    store = LocalSessionStore(tmp_path)

    with pytest.raises(SessionNotFoundError, match="格式无效"):
        store.load("../../outside")

"""CLI Session 命令路由测试。"""

from collections.abc import Sequence
from pathlib import Path

from specpilot.cli import handle_session_command
from specpilot.integrations.filesystem.session_store import LocalSessionStore
from specpilot.runtime.session.manager import SessionManager
from specpilot.runtime.session.models import SessionRecord


class FixedSessionPicker:
    """返回预设结果并记录 CLI 交给选择器的上下文。"""

    def __init__(self, selected_session_id: str | None) -> None:
        self.selected_session_id = selected_session_id
        self.seen_session_ids: tuple[str, ...] = ()
        self.seen_current_session_id = ""

    def pick(
        self,
        sessions: Sequence[SessionRecord],
        current_session_id: str,
    ) -> str | None:
        """记录候选列表并返回测试指定的选择。"""

        self.seen_session_ids = tuple(session.session_id for session in sessions)
        self.seen_current_session_id = current_session_id
        return self.selected_session_id


def make_manager(tmp_path: Path) -> SessionManager:
    """创建带两个确定性 ID 的 SessionManager。"""

    ids = iter(("SS-000000000001", "SS-000000000002"))
    manager = SessionManager(LocalSessionStore(tmp_path), id_factory=lambda: next(ids))
    manager.start()
    return manager


def test_cli_creates_lists_switches_and_renames_sessions(tmp_path: Path) -> None:
    """Session 命令只在输入边界修改当前活动对话。"""

    manager = make_manager(tmp_path)
    first_id = manager.current.session_id
    output: list[str] = []

    assert handle_session_command("/new 审计需求", manager, output.append) == "session_changed"
    second_id = manager.current.session_id
    assert second_id != first_id
    assert manager.current.title == "审计需求"

    assert handle_session_command("/sessions", manager, output.append) == "handled"
    assert any(line.startswith(f"* {second_id}") for line in output)
    assert any(first_id in line for line in output)

    assert handle_session_command(f"/switch {first_id}", manager, output.append) == (
        "session_changed"
    )
    assert handle_session_command("/rename 导出需求", manager, output.append) == "handled"
    assert manager.current.title == "导出需求"


def test_cli_status_and_command_boundaries(tmp_path: Path) -> None:
    """状态命令可查看当前绑定，/done 仍交给 Agent 最终总结轮。"""

    manager = make_manager(tmp_path)
    output: list[str] = []

    assert handle_session_command("/status", manager, output.append) == "handled"
    assert manager.current.session_id in output[-1]
    assert manager.current.spec_id in output[-1]
    assert handle_session_command("/done", manager, output.append) == "not_command"
    assert handle_session_command("普通需求", manager, output.append) == "not_command"
    assert handle_session_command("/quit", manager, output.append) == "quit"


def test_cli_rejects_unknown_or_incomplete_session_commands(tmp_path: Path) -> None:
    """取消选择或未知命令不会意外创建、切换或重命名 Session。"""

    manager = make_manager(tmp_path)
    original = manager.current
    output: list[str] = []

    assert (
        handle_session_command(
            "/switch",
            manager,
            output.append,
            session_picker=FixedSessionPicker(None),
        )
        == "handled"
    )
    assert handle_session_command("/rename", manager, output.append) == "handled"
    assert handle_session_command("/unknown", manager, output.append) == "handled"

    assert manager.current.session_id == original.session_id
    assert manager.current.title == original.title
    assert output == [
        "用法：/rename <标题>",
        "未知命令：/unknown",
    ]


def test_cli_switch_picker_uses_the_existing_switch_result_path(tmp_path: Path) -> None:
    """无参数选择确认后复用直接传 ID 的提示和命令结果。"""

    manager = make_manager(tmp_path)
    first_id = manager.current.session_id
    manager.create("第二个对话")
    picker = FixedSessionPicker(first_id)
    output: list[str] = []

    result = handle_session_command(
        "/switch",
        manager,
        output.append,
        session_picker=picker,
    )

    assert result == "session_changed"
    assert manager.current.session_id == first_id
    assert picker.seen_current_session_id == "SS-000000000002"
    assert set(picker.seen_session_ids) == {first_id, "SS-000000000002"}
    assert output == [f"已切换到 Session：{first_id} · 新对话"]


def test_cli_switch_picker_cancellation_does_not_write_session_state(tmp_path: Path) -> None:
    """选择器取消时 active index、Session 内容和当前内存状态均保持不变。"""

    manager = make_manager(tmp_path)
    manager.create("第二个对话")
    current = manager.current
    storage_root = tmp_path / ".specpilot" / "sessions"
    index_path = storage_root / "index.json"
    session_path = storage_root / current.session_id / "session.json"
    index_before = index_path.read_bytes()
    session_before = session_path.read_bytes()

    result = handle_session_command(
        "/switch",
        manager,
        session_picker=FixedSessionPicker(None),
    )

    assert result == "handled"
    assert manager.current == current
    assert index_path.read_bytes() == index_before
    assert session_path.read_bytes() == session_before


def test_cli_switch_picker_preserves_interrupted_warning(tmp_path: Path) -> None:
    """选择已中断 Session 后仍输出原有的不自动重放提示。"""

    manager = make_manager(tmp_path)
    interrupted_id = manager.current.session_id
    manager.begin_turn("未完成请求")
    manager.interrupt_turn()
    manager.create("第二个对话")
    output: list[str] = []

    result = handle_session_command(
        "/switch",
        manager,
        output.append,
        session_picker=FixedSessionPicker(interrupted_id),
    )

    assert result == "session_changed"
    assert output == [
        f"已切换到 Session：{interrupted_id} · 新对话",
        "该 Session 的上一轮未完整结束，系统不会自动重放模型或工具调用。",
    ]

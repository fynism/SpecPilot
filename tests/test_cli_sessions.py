"""CLI Session 命令路由测试。"""

from pathlib import Path

from specpilot.cli import handle_session_command
from specpilot.integrations.filesystem.session_store import LocalSessionStore
from specpilot.runtime.session.manager import SessionManager


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
    """缺少参数或未知命令不会意外创建、切换或重命名 Session。"""

    manager = make_manager(tmp_path)
    original = manager.current
    output: list[str] = []

    assert handle_session_command("/switch", manager, output.append) == "handled"
    assert handle_session_command("/rename", manager, output.append) == "handled"
    assert handle_session_command("/unknown", manager, output.append) == "handled"

    assert manager.current.session_id == original.session_id
    assert manager.current.title == original.title
    assert output == [
        "用法：/switch <session-id>",
        "用法：/rename <标题>",
        "未知命令：/unknown",
    ]

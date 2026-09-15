"""Session 恢复上下文的终端展示测试。"""

from datetime import UTC, datetime
from typing import Any

from specpilot.integrations.terminal.session_presenter import (
    SessionContextPresenter,
    build_transcript,
)
from specpilot.runtime.session.models import create_session_record

NOW = datetime(2026, 9, 15, 8, 0, tzinfo=UTC)


def test_transcript_keeps_recent_readable_messages_and_skips_tools() -> None:
    """恢复视图只保留最近可读文本，不展开工具调用和工具结果。"""

    messages: list[dict[str, Any]] = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": f"消息 {index}"}
        for index in range(12)
    ]
    messages.insert(
        4,
        {
            "role": "user",
            "content": [{"type": "tool_result", "content": "很长的仓库工具结果"}],
        },
    )

    entries, omitted = build_transcript(messages, history_limit=3)

    assert [entry.text for entry in entries] == ["消息 9", "消息 10", "消息 11"]
    assert omitted == 9


def test_presenter_clears_then_shows_session_spec_and_persisted_context() -> None:
    """进入 Session 时先清屏，再展示身份、Spec 与持久化对话。"""

    session = create_session_record(
        "导出\n需求",
        clock=lambda: NOW,
        id_factory=lambda: "SS-000000000001",
    ).model_copy(
        update={
            "messages": [
                {"role": "user", "content": "只允许管理员导出"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "name": "get_spec", "input": {}},
                        {"type": "text", "text": "已经记录权限限制。"},
                    ],
                },
            ]
        }
    )
    events: list[str] = []
    presenter = SessionContextPresenter(
        emit=lambda line: events.append(f"输出:{line}"),
        clear_screen=lambda: events.append("清屏"),
    )

    presenter.present(session, session.spec_versions[-1])

    assert events[0] == "清屏"
    assert f"输出:Session：导出 需求 · {session.session_id} · waiting_for_user" in events
    assert f"输出:Spec：{session.spec_id} · v1 · draft" in events
    assert "输出:你：只允许管理员导出" in events
    assert "输出:Agent：已经记录权限限制。" in events
    assert not any("tool_use" in event or "get_spec" in event for event in events)


def test_presenter_marks_interrupted_session_and_truncates_long_messages() -> None:
    """恢复已中断 Session 时保留警告，且长消息不会刷满终端。"""

    session = create_session_record(
        clock=lambda: NOW,
        id_factory=lambda: "SS-000000000001",
    ).model_copy(
        update={
            "status": "interrupted",
            "active_request": "未完成请求",
            "messages": [{"role": "user", "content": "很长的消息内容"}],
        }
    )
    output: list[str] = []
    presenter = SessionContextPresenter(
        emit=output.append,
        clear_screen=lambda: None,
        message_limit=5,
    )

    presenter.present(session, session.spec_versions[-1])

    assert "注意：上一轮未完整结束，系统不会自动重放模型或工具调用。" in output
    assert "你：很长的消…" in output

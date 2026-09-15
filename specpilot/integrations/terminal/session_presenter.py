"""清空终端可视区域并展示当前 Session 的持久化上下文。"""

import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, TextIO

from prompt_toolkit.shortcuts import clear

from specpilot.capabilities.spec.models import Specification
from specpilot.integrations.terminal.text import safe_terminal_text
from specpilot.runtime.session.models import SessionRecord

DEFAULT_HISTORY_LIMIT = 10
DEFAULT_MESSAGE_LIMIT = 800


@dataclass(frozen=True)
class TranscriptEntry:
    """表示可以安全呈现在终端中的一条对话文本。"""

    speaker: str
    text: str


def build_transcript(
    messages: Sequence[dict[str, Any]],
    *,
    history_limit: int = DEFAULT_HISTORY_LIMIT,
    message_limit: int = DEFAULT_MESSAGE_LIMIT,
) -> tuple[tuple[TranscriptEntry, ...], int]:
    """提取最近的可读对话文本，并省略 Tool Use 与 Tool Result。"""

    if history_limit <= 0 or message_limit <= 0:
        raise ValueError("上下文展示数量和单条长度必须大于零")

    visible: list[TranscriptEntry] = []
    for message in messages:
        text = _message_text(message.get("content"))
        if not text:
            continue
        role = message.get("role")
        if role not in {"user", "assistant"}:
            continue
        speaker = "你" if role == "user" else "Agent"
        visible.append(
            TranscriptEntry(
                speaker=speaker,
                text=_truncate(safe_terminal_text(text), message_limit),
            )
        )

    omitted = max(len(visible) - history_limit, 0)
    return tuple(visible[-history_limit:]), omitted


class SessionContextPresenter:
    """展示 Session 标识、Spec 状态及最近的持久化可读对话。"""

    def __init__(
        self,
        emit: Callable[[str], None] = print,
        clear_screen: Callable[[], None] = clear,
        *,
        history_limit: int = DEFAULT_HISTORY_LIMIT,
        message_limit: int = DEFAULT_MESSAGE_LIMIT,
    ) -> None:
        """注入输出与清屏函数，使终端行为可被确定性测试。"""

        self._emit = emit
        self._clear_screen = clear_screen
        self._history_limit = history_limit
        self._message_limit = message_limit

    def present(self, session: SessionRecord, spec: Specification) -> None:
        """清屏后展示当前 Session，并明确提示被省略的较早上下文。"""

        entries, omitted = build_transcript(
            session.messages,
            history_limit=self._history_limit,
            message_limit=self._message_limit,
        )
        self._clear_screen()
        self._emit("SpecPilot · 已进入 Session")
        title = safe_terminal_text(session.title)
        self._emit(f"Session：{title} · {session.session_id} · {session.status}")
        self._emit(f"Spec：{spec.spec_id} · v{spec.version} · {spec.status}")
        if session.status == "interrupted":
            self._emit("注意：上一轮未完整结束，系统不会自动重放模型或工具调用。")
        self._emit("")
        self._emit("── 最近对话 ──")
        self._emit("")
        if entries:
            for entry in entries:
                self._emit(f"{entry.speaker}：{entry.text}")
        else:
            self._emit("暂无持久化对话内容。")
        if omitted:
            self._emit("")
            self._emit(f"── 更早还有 {omitted} 条可读消息未显示 ──")
        self._emit("")
        self._emit("输入需求；输入 / 查看命令，输入 /done 结束澄清。")
        self._emit("")


def build_session_presenter(
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    emit: Callable[[str], None] = print,
) -> SessionContextPresenter:
    """TTY 清空可视区域；重定向环境保留已有输出。"""

    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    # 管道与日志采集依赖连续输出，不能写入清屏控制序列；只有真实交互终端清屏。
    clear_screen = clear if input_stream.isatty() and output_stream.isatty() else lambda: None
    return SessionContextPresenter(emit=emit, clear_screen=clear_screen)


def _message_text(content: object) -> str | None:
    """只提取用户或 Agent 可读文本，不展开工具协议块。"""

    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts = [
        block["text"]
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    return " ".join(parts) or None


def _truncate(value: str, limit: int) -> str:
    """限制单条上下文长度，避免恢复时被历史长文本刷满终端。"""

    if len(value) <= limit:
        return value
    return f"{value[: limit - 1]}…"

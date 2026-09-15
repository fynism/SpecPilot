"""提供支持分页与非交互回退的 Session 终端选择器。"""

import sys
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol, TextIO

from prompt_toolkit.application import Application
from prompt_toolkit.formatted_text import StyleAndTextTuples
from prompt_toolkit.input import Input
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.layout import Layout, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.output import Output
from prompt_toolkit.styles import Style

from specpilot.runtime.session.models import SessionRecord

DEFAULT_PAGE_SIZE = 10


@dataclass(frozen=True)
class SessionChoice:
    """保存选择器展示所需的稳定 Session 摘要。"""

    session_id: str
    line: str


@dataclass
class _PickerState:
    """保存交互选择器当前页与页内高亮位置。"""

    page_index: int
    row_index: int


class SessionPicker(Protocol):
    """定义 CLI 选择 Session 所需的最小终端接口。"""

    def pick(
        self,
        sessions: Sequence[SessionRecord],
        current_session_id: str,
    ) -> str | None:
        """返回用户明确确认的 Session ID；取消时返回空值。"""


def build_session_choices(sessions: Sequence[SessionRecord]) -> tuple[SessionChoice, ...]:
    """按最近活动时间排序并生成统一的 Session 展示行。"""

    ordered = sorted(sessions, key=lambda session: session.updated_at, reverse=True)
    return tuple(
        SessionChoice(
            session_id=session.session_id,
            line=(
                f"{_short_session_id(session.session_id)} · {_safe_terminal_text(session.title)} · "
                f"{session.status} · {session.updated_at.isoformat(timespec='seconds')} · "
                f"{len(session.messages)} 条消息"
            ),
        )
        for session in ordered
    )


class InteractiveSessionPicker:
    """使用方向键和分页按键选择当前 worktree 中的 Session。"""

    def __init__(
        self,
        input: Input | None = None,
        output: Output | None = None,
        *,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> None:
        """允许测试注入虚拟终端，并校验固定分页大小。"""

        if page_size <= 0:
            raise ValueError("Session 选择器每页数量必须大于零")
        self._input = input
        self._output = output
        self._page_size = page_size

    def pick(
        self,
        sessions: Sequence[SessionRecord],
        current_session_id: str,
    ) -> str | None:
        """等待用户确认一个 Session，取消时不返回默认高亮项。"""

        choices = build_session_choices(sessions)
        if not choices:
            return None

        current_index = next(
            (
                index
                for index, choice in enumerate(choices)
                if choice.session_id == current_session_id
            ),
            0,
        )
        state = _PickerState(
            page_index=current_index // self._page_size,
            row_index=current_index % self._page_size,
        )
        page_count = (len(choices) + self._page_size - 1) // self._page_size
        bindings = KeyBindings()

        def current_page() -> tuple[SessionChoice, ...]:
            """返回当前页，避免按键处理越过页内有效范围。"""

            start = state.page_index * self._page_size
            return choices[start : start + self._page_size]

        def change_page(delta: int, event: KeyPressEvent) -> None:
            """翻页时保留尽可能相同的页内位置。"""

            target_page = min(max(state.page_index + delta, 0), page_count - 1)
            if target_page == state.page_index:
                return
            state.page_index = target_page
            state.row_index = min(state.row_index, len(current_page()) - 1)
            event.app.invalidate()

        @bindings.add("up")
        def select_previous(event: KeyPressEvent) -> None:
            """只在当前页内向上移动高亮项。"""

            state.row_index = max(state.row_index - 1, 0)
            event.app.invalidate()

        @bindings.add("down")
        def select_next(event: KeyPressEvent) -> None:
            """只在当前页内向下移动高亮项。"""

            state.row_index = min(state.row_index + 1, len(current_page()) - 1)
            event.app.invalidate()

        @bindings.add("pageup")
        @bindings.add("p")
        def previous_page(event: KeyPressEvent) -> None:
            """通过 PgUp 或 p 查看上一页。"""

            change_page(-1, event)

        @bindings.add("pagedown")
        @bindings.add("n")
        def next_page(event: KeyPressEvent) -> None:
            """通过 PgDn 或 n 查看下一页。"""

            change_page(1, event)

        @bindings.add("enter")
        def submit(event: KeyPressEvent) -> None:
            """只有显式确认才返回当前高亮 Session。"""

            event.app.exit(result=current_page()[state.row_index].session_id)

        @bindings.add("escape")
        @bindings.add("c-c")
        @bindings.add("c-d")
        def cancel(event: KeyPressEvent) -> None:
            """取消时返回空值，不能把默认高亮项误认为用户选择。"""

            event.app.exit(result=None)

        application: Application[str | None] = Application(
            layout=Layout(
                Window(
                    FormattedTextControl(lambda: self._render(choices, state, page_count)),
                    height=Dimension(min=5, preferred=self._page_size + 5),
                    wrap_lines=False,
                )
            ),
            key_bindings=bindings,
            style=Style.from_dict(
                {
                    "title": "bold ansicyan",
                    "selected": "reverse",
                    "help": "ansibrightblack",
                }
            ),
            full_screen=False,
            mouse_support=False,
            input=self._input,
            output=self._output,
        )
        try:
            return application.run()
        except (EOFError, KeyboardInterrupt):
            return None

    def _render(
        self,
        choices: tuple[SessionChoice, ...],
        state: _PickerState,
        page_count: int,
    ) -> StyleAndTextTuples:
        """渲染当前页、页码和操作提示。"""

        start = state.page_index * self._page_size
        page = choices[start : start + self._page_size]
        fragments: StyleAndTextTuples = [
            ("class:title", "选择要切换到的 Session\n\n"),
        ]
        for index, choice in enumerate(page):
            cursor = "❯" if index == state.row_index else " "
            style = "class:selected" if index == state.row_index else ""
            fragments.append((style, f"{cursor} {choice.line}\n"))
        fragments.extend(
            [
                ("class:help", f"\n第 {state.page_index + 1}/{page_count} 页\n"),
                (
                    "class:help",
                    "↑↓ 页内选择 · PgUp/PgDn 或 p/n 翻页 · Enter 确认 · Esc 取消\n",
                ),
            ]
        )
        return fragments


class ConsoleSessionPicker:
    """在非 TTY 环境使用无控制序列的编号输入选择 Session。"""

    def __init__(
        self,
        read: Callable[[str], str] = input,
        emit: Callable[[str], None] = print,
    ) -> None:
        """允许测试注入逐行输入与输出函数。"""

        self._read = read
        self._emit = emit

    def pick(
        self,
        sessions: Sequence[SessionRecord],
        current_session_id: str,
    ) -> str | None:
        """一次性输出全部 Session，并等待有效序号或取消。"""

        del current_session_id  # 编号列表不需要高亮，但接口与 TTY 选择器保持一致。
        choices = build_session_choices(sessions)
        if not choices:
            self._emit("当前 worktree 没有可切换的 Session。")
            return None

        self._emit("可切换的 Session：")
        for index, choice in enumerate(choices, start=1):
            self._emit(f"{index}. {choice.line}")

        while True:
            try:
                raw = self._read("请输入 Session 序号（Esc/Ctrl+C 取消）：").strip()
            except (EOFError, KeyboardInterrupt):
                return None
            if raw == "\x1b":
                return None
            try:
                selected = int(raw)
            except ValueError:
                self._emit(f"请输入 1 到 {len(choices)} 之间的有效序号。")
                continue
            if not 1 <= selected <= len(choices):
                self._emit(f"请输入 1 到 {len(choices)} 之间的有效序号。")
                continue
            return choices[selected - 1].session_id


def build_session_picker(
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> SessionPicker:
    """根据标准输入输出是否为 TTY 选择交互或编号回退实现。"""

    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    # prompt_toolkit 只有在输入输出都是真实 TTY 时才可安全处理按键；重定向环境必须使用
    # 可预测的逐行回退，避免控制序列污染输出或应用无法退出。
    if input_stream.isatty() and output_stream.isatty():
        return InteractiveSessionPicker()
    return ConsoleSessionPicker()


def _short_session_id(session_id: str) -> str:
    """保留类型前缀和末八位，提供紧凑且可辨识的展示 ID。"""

    prefix, separator, suffix = session_id.partition("-")
    if not separator:
        return session_id[-8:]
    return f"{prefix}-{suffix[-8:]}"


def _safe_terminal_text(value: str) -> str:
    """移除标题中的控制字符，防止持久化文本改变终端布局或样式。"""

    cleaned = "".join(
        " " if unicodedata.category(character).startswith("C") else character for character in value
    )
    return " ".join(cleaned.split())

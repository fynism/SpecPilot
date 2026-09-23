"""提供拥有单一事件循环的 SpecPilot 全屏终端界面。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from threading import Event, Lock, Thread
from typing import Any, Literal, Protocol

from prompt_toolkit.application import Application
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import StyleAndTextTuples
from prompt_toolkit.input import Input
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.layout import Float, FloatContainer, HSplit, Layout, Window
from prompt_toolkit.layout.containers import ConditionalContainer
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.output import Output
from prompt_toolkit.styles import Style
from prompt_toolkit.widgets import TextArea

from specpilot.capabilities.clarification.models import (
    ClarificationAnswer,
    ClarificationRequest,
)
from specpilot.capabilities.clarification.tool import (
    ClarificationCancelled,
    ClarificationPresenter,
)
from specpilot.integrations.terminal.command_prompt import SlashCommandCompleter
from specpilot.integrations.terminal.session_picker import (
    DEFAULT_PAGE_SIZE,
    SessionChoice,
    build_session_choices,
)
from specpilot.integrations.terminal.session_presenter import build_transcript
from specpilot.integrations.terminal.text import safe_terminal_text
from specpilot.runtime.session.manager import SessionManager
from specpilot.runtime.session.store import SessionNotFoundError, SessionStorageError

SessionCommandResult = Literal["not_command", "handled", "session_changed", "quit"]
RuntimeFactory = Callable[
    [ClarificationPresenter, Callable[[str], None]],
    "AgentRunner",
]
CommandHandler = Callable[[str, Callable[[str], None]], SessionCommandResult]


class HookDispatcher(Protocol):
    """定义 TUI 提交用户输入所需的 Hook 调用接口。"""

    def trigger(self, event: str, *args: Any) -> Any:
        """触发一个运行时事件。"""


class AgentRunner(Protocol):
    """定义 TUI 驱动一个传统 Agent Loop 所需的最小接口。"""

    @property
    def hooks(self) -> HookDispatcher:
        """返回支持 UserPromptSubmit 的 Hook 注册表。"""

    def run(
        self,
        messages: list[dict[str, Any]],
        *,
        tools_enabled: bool = True,
    ) -> str:
        """运行完整 Agent Loop 并返回停止原因。"""


class ClarificationWaiter:
    """在线程之间传递一次澄清答案或取消信号。"""

    def __init__(self) -> None:
        self._event = Event()
        self._lock = Lock()
        self._answer: ClarificationAnswer | None = None
        self._cancelled = False

    def submit(self, answer: ClarificationAnswer) -> None:
        """只接受第一次终态，避免重复按键覆盖用户答案。"""

        with self._lock:
            if self._event.is_set():
                return
            self._answer = answer
            self._event.set()

    def cancel(self) -> None:
        """唤醒等待中的 Agent Worker，并把结果标记为取消。"""

        with self._lock:
            if self._event.is_set():
                return
            self._cancelled = True
            self._event.set()

    def wait(self) -> ClarificationAnswer:
        """同步等待 TUI 回答，以保持现有 ClarificationPresenter 契约。"""

        self._event.wait()
        if self._cancelled or self._answer is None:
            raise ClarificationCancelled
        return self._answer


class TuiClarificationPresenter:
    """把 Worker 中的同步澄清请求桥接到 TUI 事件循环。"""

    def __init__(
        self,
        show_request: Callable[[ClarificationRequest, ClarificationWaiter], None],
    ) -> None:
        self._show_request = show_request
        self._active_lock = Lock()
        self._active: ClarificationWaiter | None = None

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """通知 TUI 展示请求，并阻塞当前 Agent Worker 直到用户回答。"""

        waiter = ClarificationWaiter()
        with self._active_lock:
            if self._active is not None:
                raise RuntimeError("同一 TUI 不能同时等待多个澄清请求")
            self._active = waiter
        try:
            self._show_request(request, waiter)
            return waiter.wait()
        finally:
            with self._active_lock:
                self._active = None

    def cancel_active(self) -> None:
        """TUI 退出时取消仍在等待的澄清，避免 Worker 永久阻塞。"""

        with self._active_lock:
            if self._active is not None:
                self._active.cancel()


@dataclass
class _ClarificationOverlay:
    """保存澄清浮层的高亮、显式选择和跨线程等待对象。"""

    request: ClarificationRequest
    waiter: ClarificationWaiter
    highlighted_index: int
    explicit_selection: bool = False


@dataclass
class _SessionOverlay:
    """保存 Session 选择浮层的分页位置。"""

    choices: tuple[SessionChoice, ...]
    page_index: int
    row_index: int


class FullScreenTui:
    """统一管理对话、输入、命令、Session 与澄清浮层的全屏应用。"""

    def __init__(
        self,
        manager: SessionManager,
        runtime_factory: RuntimeFactory,
        command_handler: CommandHandler,
        tools_enabled_for: Callable[[str], bool],
        *,
        input: Input | None = None,
        output: Output | None = None,
    ) -> None:
        """装配单一 prompt_toolkit Application 与后台 Agent Worker。"""

        self._manager = manager
        self._runtime_factory = runtime_factory
        self._command_handler = command_handler
        self._tools_enabled_for = tools_enabled_for
        self._running = False
        self._status = "等待输入"
        self._notices: list[str] = []
        self._clarification: _ClarificationOverlay | None = None
        self._session_overlay: _SessionOverlay | None = None
        self._session_title = ""
        self._session_id = ""
        self._session_status = ""
        self._spec_summary = ""
        self._conversation_lines: list[str] = []

        self._clarification_presenter = TuiClarificationPresenter(self._request_clarification)
        self._runtime = self._runtime_factory(
            self._clarification_presenter,
            self._append_runtime_event,
        )
        self._completer = SlashCommandCompleter()
        self._transcript = TextArea(
            text="",
            read_only=True,
            focusable=False,
            scrollbar=True,
            wrap_lines=True,
        )
        self._input = TextArea(
            height=3,
            multiline=False,
            prompt=[("class:prompt", "❯ ")],
            completer=self._completer,
            complete_while_typing=True,
            accept_handler=self._accept_input,
            read_only=Condition(self._input_is_locked),
            style="class:input",
        )
        self._overlay_control = FormattedTextControl(self._render_overlay)
        self._bindings = self._build_key_bindings()
        body = HSplit(
            [
                Window(FormattedTextControl(self._render_header), height=3),
                Window(height=1, char="─", style="class:separator"),
                self._transcript,
                Window(FormattedTextControl(self._render_status), height=1),
                Window(height=1, char="─", style="class:separator"),
                self._input,
                Window(FormattedTextControl(self._render_help), height=1),
            ]
        )
        root = FloatContainer(
            content=body,
            floats=[
                Float(
                    xcursor=True,
                    ycursor=True,
                    content=CompletionsMenu(max_height=8, scroll_offset=1),
                ),
                Float(
                    top=2,
                    left=4,
                    right=4,
                    content=ConditionalContainer(
                        Window(
                            self._overlay_control,
                            height=Dimension(min=8, preferred=18),
                            wrap_lines=True,
                            style="class:overlay",
                        ),
                        filter=Condition(self._overlay_is_visible),
                    ),
                ),
            ],
        )
        self._application: Application[None] = Application(
            layout=Layout(root, focused_element=self._input),
            key_bindings=self._bindings,
            style=Style.from_dict(
                {
                    "header": "bold ansicyan",
                    "muted": "ansibrightblack",
                    "status": "reverse",
                    "separator": "ansibrightblack",
                    "prompt": "bold ansicyan",
                    "input": "",
                    "overlay": "bg:#202020 #ffffff",
                    "selected": "reverse bold",
                    "recommended": "ansiyellow",
                }
            ),
            full_screen=True,
            mouse_support=False,
            input=input,
            output=output,
        )
        self._refresh_session_view()

    @property
    def application(self) -> Application[None]:
        """暴露只读 Application 供终端契约测试检查。"""

        return self._application

    @property
    def is_running_agent(self) -> bool:
        """返回 TUI 是否仍在等待当前 Agent Loop 完成。"""

        return self._running

    @property
    def has_active_overlay(self) -> bool:
        """返回 Session 或 Clarification 浮层是否已经显示。"""

        return self._overlay_is_visible()

    def run(self) -> None:
        """进入 alternate screen，退出时由 prompt_toolkit 恢复原终端。"""

        try:
            self._application.run()
        except (EOFError, KeyboardInterrupt):
            return
        finally:
            self._clarification_presenter.cancel_active()

    def _build_key_bindings(self) -> KeyBindings:
        """建立全局退出、浮层导航与命令补全按键。"""

        bindings = KeyBindings()
        modal = Condition(self._overlay_is_visible)
        clarification = Condition(lambda: self._clarification is not None)
        session_picker = Condition(lambda: self._session_overlay is not None)

        @bindings.add("c-c")
        @bindings.add("c-q")
        def cancel_or_exit(event: KeyPressEvent) -> None:
            """优先取消浮层；运行中拒绝不安全退出；空闲时退出 TUI。"""

            if self._clarification is not None:
                self._cancel_clarification()
            elif self._session_overlay is not None:
                self._session_overlay = None
                event.app.invalidate()
            elif self._running:
                self._append_notice("Agent 正在运行，当前版本不能安全中断模型或工具调用。")
            else:
                event.app.exit()

        @bindings.add("escape", filter=modal)
        def close_overlay(event: KeyPressEvent) -> None:
            """Esc 取消当前浮层，不把高亮项当成用户确认。"""

            if self._clarification is not None:
                self._cancel_clarification()
            else:
                self._session_overlay = None
                event.app.invalidate()

        @bindings.add("up", filter=modal)
        def select_previous(event: KeyPressEvent) -> None:
            """在当前浮层页内移动到上一项。"""

            self._move_overlay_selection(-1)
            event.app.invalidate()

        @bindings.add("down", filter=modal)
        def select_next(event: KeyPressEvent) -> None:
            """在当前浮层页内移动到下一项。"""

            self._move_overlay_selection(1)
            event.app.invalidate()

        @bindings.add("pageup", filter=session_picker)
        @bindings.add("p", filter=session_picker)
        def previous_page(event: KeyPressEvent) -> None:
            """Session 浮层翻到上一页。"""

            self._change_session_page(-1)
            event.app.invalidate()

        @bindings.add("pagedown", filter=session_picker)
        @bindings.add("n", filter=session_picker)
        def next_page(event: KeyPressEvent) -> None:
            """Session 浮层翻到下一页。"""

            self._change_session_page(1)
            event.app.invalidate()

        @bindings.add("enter", filter=modal)
        def confirm_overlay(event: KeyPressEvent) -> None:
            """确认 Session 或提交当前澄清答案。"""

            if self._clarification is not None:
                self._answer_clarification()
            else:
                self._confirm_session_switch()
            event.app.invalidate()

        @bindings.add("tab", filter=clarification)
        def mark_clarification_option(event: KeyPressEvent) -> None:
            """把当前高亮项标为显式选择，使其可与文字补充同时提交。"""

            assert self._clarification is not None
            self._clarification.explicit_selection = True
            event.app.invalidate()

        @bindings.add("tab", filter=~modal)
        def complete_command(event: KeyPressEvent) -> None:
            """唯一命令一次补全，多项命令在候选之间移动。"""

            buffer = event.current_buffer
            completions = list(
                self._completer.get_completions(
                    buffer.document,
                    CompleteEvent(completion_requested=True),
                )
            )
            if len(completions) == 1:
                buffer.cancel_completion()
                buffer.apply_completion(completions[0])
            elif completions:
                if buffer.complete_state is None:
                    buffer.start_completion(select_first=True)
                else:
                    buffer.complete_next()

        @bindings.add("pageup", filter=~modal)
        def scroll_transcript_up(event: KeyPressEvent) -> None:
            """不改变输入焦点，向上滚动持久化对话区。"""

            self._transcript.buffer.cursor_up(count=10)
            event.app.invalidate()

        @bindings.add("pagedown", filter=~modal)
        def scroll_transcript_down(event: KeyPressEvent) -> None:
            """不改变输入焦点，向下滚动持久化对话区。"""

            self._transcript.buffer.cursor_down(count=10)
            event.app.invalidate()

        return bindings

    def _accept_input(self, buffer: Buffer) -> bool:
        """把输入路由到命令或后台 Agent Loop，并保留全屏应用。"""

        query = buffer.text.strip()
        buffer.text = ""
        if not query or self._running or self._overlay_is_visible():
            return True
        if query == "/switch":
            self._open_session_picker()
            return True

        result = self._command_handler(query, self._append_notice)
        if result == "quit":
            self._application.exit()
            return True
        if result == "session_changed":
            self._notices.clear()
            self._rebuild_runtime()
            self._refresh_session_view()
            return True
        if result == "handled":
            self._application.invalidate()
            return True

        hook_result = self._runtime.hooks.trigger("UserPromptSubmit", self._manager.messages, query)
        if hook_result == "stop":
            self._application.exit()
            return True

        self._manager.begin_turn(query)
        self._running = True
        self._status = "Agent 正在运行…"
        self._refresh_session_view()
        Thread(
            target=self._run_agent,
            args=(self._tools_enabled_for(query),),
            daemon=True,
            name="specpilot-agent-loop",
        ).start()
        return True

    def _run_agent(self, tools_enabled: bool) -> None:
        """在 Worker 中运行传统 Agent Loop，避免阻塞 TUI 重绘。"""

        try:
            stop_reason = self._runtime.run(
                self._manager.messages,
                tools_enabled=tools_enabled,
            )
            self._manager.complete_turn()
        except Exception as exc:
            error_name = type(exc).__name__
            try:
                self._manager.interrupt_turn()
            except Exception as interrupt_exc:
                error_name = f"{error_name}/{type(interrupt_exc).__name__}"
            self._schedule_ui(lambda: self._finish_agent_failure(error_name))
            return
        self._schedule_ui(lambda: self._finish_agent_success(stop_reason))

    def _finish_agent_success(self, stop_reason: str) -> None:
        """在 UI 线程恢复输入，并展示已持久化的完整轮次。"""

        self._running = False
        if stop_reason == "max_tool_use_turns":
            self._status = "本轮达到工具调用上限，可继续下一轮"
        else:
            self._status = "等待输入"
        self._refresh_session_view()
        self._application.layout.focus(self._input)

    def _finish_agent_failure(self, error_name: str) -> None:
        """在失败后重建运行时并显示脱敏错误类型。"""

        self._running = False
        self._status = f"Agent 运行失败：{error_name}；本轮已标记为中断"
        self._rebuild_runtime()
        self._refresh_session_view()
        self._application.layout.focus(self._input)

    def _request_clarification(
        self,
        request: ClarificationRequest,
        waiter: ClarificationWaiter,
    ) -> None:
        """从 Worker 安排 UI 线程打开澄清浮层。"""

        def show() -> None:
            recommended = next(
                index
                for index, option in enumerate(request.options)
                if option.id == request.recommended_option_id
            )
            self._clarification = _ClarificationOverlay(request, waiter, recommended)
            self._input.buffer.text = ""
            self._status = "等待你的澄清选择"
            self._application.invalidate()

        self._schedule_ui(show)

    def _answer_clarification(self) -> None:
        """提交高亮选项、自由文字或二者组合，并让 Agent Worker 继续。"""

        overlay = self._clarification
        if overlay is None:
            return
        free_text = self._input.text.strip() or None
        selected_option_id = None
        if overlay.explicit_selection or free_text is None:
            selected_option_id = overlay.request.options[overlay.highlighted_index].id
        overlay.waiter.submit(
            ClarificationAnswer(
                request_id=overlay.request.request_id,
                selected_option_id=selected_option_id,
                free_text=free_text,
            )
        )
        self._clarification = None
        self._input.buffer.text = ""
        self._status = "Agent 正在继续…"

    def _cancel_clarification(self) -> None:
        """取消澄清并唤醒 Worker，不记录高亮推荐项。"""

        overlay = self._clarification
        if overlay is None:
            return
        overlay.waiter.cancel()
        self._clarification = None
        self._input.buffer.text = ""
        self._status = "Agent 正在继续…"
        self._application.invalidate()

    def _open_session_picker(self) -> None:
        """在当前 Application 内打开分页 Session 浮层。"""

        choices = build_session_choices(self._manager.list_sessions())
        current_id = self._manager.current.session_id
        current_index = next(
            (index for index, choice in enumerate(choices) if choice.session_id == current_id),
            0,
        )
        self._session_overlay = _SessionOverlay(
            choices=choices,
            page_index=current_index // DEFAULT_PAGE_SIZE,
            row_index=current_index % DEFAULT_PAGE_SIZE,
        )
        self._application.invalidate()

    def _confirm_session_switch(self) -> None:
        """确认 Session 浮层选择并沿用既有切换与运行时重建语义。"""

        overlay = self._session_overlay
        if overlay is None:
            return
        page = self._session_page(overlay)
        session_id = page[overlay.row_index].session_id
        try:
            session = self._manager.switch(session_id)
        except (SessionNotFoundError, SessionStorageError) as exc:
            self._append_notice(f"无法切换 Session：{exc}")
            return
        self._session_overlay = None
        self._notices.clear()
        if session.status == "interrupted":
            self._notices.append("上一轮未完整结束，系统不会自动重放模型或工具调用。")
        self._rebuild_runtime()
        self._refresh_session_view()

    def _move_overlay_selection(self, delta: int) -> None:
        """只在当前浮层页内移动选择。"""

        if self._clarification is not None:
            count = len(self._clarification.request.options)
            self._clarification.highlighted_index = min(
                max(self._clarification.highlighted_index + delta, 0),
                count - 1,
            )
            self._clarification.explicit_selection = True
            return
        if self._session_overlay is not None:
            count = len(self._session_page(self._session_overlay))
            self._session_overlay.row_index = min(
                max(self._session_overlay.row_index + delta, 0),
                count - 1,
            )

    def _change_session_page(self, delta: int) -> None:
        """翻页并把页内位置约束到新页的有效范围。"""

        overlay = self._session_overlay
        if overlay is None:
            return
        page_count = (len(overlay.choices) + DEFAULT_PAGE_SIZE - 1) // DEFAULT_PAGE_SIZE
        overlay.page_index = min(max(overlay.page_index + delta, 0), page_count - 1)
        overlay.row_index = min(overlay.row_index, len(self._session_page(overlay)) - 1)

    @staticmethod
    def _session_page(overlay: _SessionOverlay) -> tuple[SessionChoice, ...]:
        """返回 Session 浮层当前页。"""

        start = overlay.page_index * DEFAULT_PAGE_SIZE
        return overlay.choices[start : start + DEFAULT_PAGE_SIZE]

    def _refresh_session_view(self) -> None:
        """从稳定 Session 快照重建页头与可滚动对话文本。"""

        session = self._manager.current
        spec = self._manager.current_spec()
        self._session_title = safe_terminal_text(session.title)
        self._session_id = session.session_id
        self._session_status = session.status
        self._spec_summary = f"{spec.spec_id} · v{spec.version} · {spec.status}"
        entries, omitted = build_transcript(
            session.messages,
            history_limit=200,
            message_limit=2000,
        )
        lines: list[str] = []
        if omitted:
            lines.append(f"── 更早还有 {omitted} 条可读消息未显示 ──")
            lines.append("")
        if entries:
            for entry in entries:
                lines.extend((f"{entry.speaker}", entry.text, ""))
        else:
            lines.extend(("欢迎使用 SpecPilot。", "输入需求，或输入 / 查看可用命令。", ""))
        self._conversation_lines = lines
        self._update_transcript_document()
        self._application.invalidate()

    def _update_transcript_document(self) -> None:
        """使用缓存的稳定对话和运行事件更新终端文档。"""

        lines = list(self._conversation_lines)
        if self._notices:
            lines.append("── 运行信息 ──")
            lines.extend(self._notices[-6:])
        text = "\n".join(lines).rstrip()
        self._transcript.buffer.set_document(
            Document(text, cursor_position=len(text)),
            bypass_readonly=True,
        )

    def _rebuild_runtime(self) -> None:
        """Session 变化或失败后重新绑定独占 Spec 与澄清状态。"""

        self._runtime = self._runtime_factory(
            self._clarification_presenter,
            self._append_runtime_event,
        )

    def _append_notice(self, message: str) -> None:
        """把普通命令输出安全地追加到当前 TUI，而不是写入 alternate screen。"""

        def append() -> None:
            self._notices.append(safe_terminal_text(message))
            self._notices = self._notices[-20:]
            # Agent Worker 运行期间 Session 正在变化；这里只重绘缓存，避免并发读取半轮状态。
            self._update_transcript_document()
            self._application.invalidate()

        self._schedule_ui(append)

    def _append_runtime_event(self, message: str) -> None:
        """接收 Runtime/Hook 事件并安排 TUI 线程刷新。"""

        self._append_notice(message)

    def _schedule_ui(self, callback: Callable[[], None]) -> None:
        """从 Worker 安全调度 UI 更新；应用未运行时直接执行以便测试。"""

        loop = self._application.loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(callback)
        else:
            callback()

    def _input_is_locked(self) -> bool:
        """运行中仅在澄清浮层打开时允许文字输入。"""

        return self._session_overlay is not None or (self._running and self._clarification is None)

    def _overlay_is_visible(self) -> bool:
        """返回是否存在由当前 Application 管理的模态浮层。"""

        return self._clarification is not None or self._session_overlay is not None

    def _render_header(self) -> StyleAndTextTuples:
        """渲染固定的 Session 与 Spec 页头。"""

        return [
            ("class:header", " SpecPilot\n"),
            ("", f" {self._session_title} · {self._session_id} · {self._session_status}\n"),
            ("class:muted", f" Spec {self._spec_summary}"),
        ]

    def _render_status(self) -> StyleAndTextTuples:
        """渲染 Agent 当前生命周期状态。"""

        return [("class:status", f" {self._status} ")]

    def _render_help(self) -> StyleAndTextTuples:
        """渲染不会进入对话历史的快捷键提示。"""

        return [
            (
                "class:muted",
                " / 命令 · Tab 补全/确认选项 · ↑↓ 选择 · Esc 取消 · Ctrl+Q 退出",
            )
        ]

    def _render_overlay(self) -> StyleAndTextTuples:
        """根据当前模式渲染 Session 或 Clarification 浮层。"""

        if self._clarification is not None:
            return self._render_clarification_overlay(self._clarification)
        if self._session_overlay is not None:
            return self._render_session_overlay(self._session_overlay)
        return []

    @staticmethod
    def _render_clarification_overlay(
        overlay: _ClarificationOverlay,
    ) -> StyleAndTextTuples:
        """渲染澄清问题、选项、推荐理由与操作说明。"""

        request = overlay.request
        fragments: StyleAndTextTuples = [
            ("class:header", f" 需要确认：{safe_terminal_text(request.question)}\n"),
            ("class:muted", f" 原因：{safe_terminal_text(request.reason)}\n\n"),
        ]
        for index, option in enumerate(request.options):
            cursor = "❯" if index == overlay.highlighted_index else " "
            recommended = option.id == request.recommended_option_id
            suffix = " [推荐]" if recommended else ""
            style = "class:selected" if index == overlay.highlighted_index else ""
            fragments.append((style, f" {cursor} {safe_terminal_text(option.label)}{suffix}\n"))
            fragments.append(("class:muted", f"     {safe_terminal_text(option.description)}\n"))
        fragments.extend(
            [
                (
                    "class:recommended",
                    f"\n 推荐理由：{safe_terminal_text(request.recommendation_reason)}\n",
                ),
                (
                    "class:muted",
                    " ↑↓ 选择 · Tab 显式选中 · 可直接输入补充 · Enter 确认 · Esc 取消",
                ),
            ]
        )
        return fragments

    def _render_session_overlay(self, overlay: _SessionOverlay) -> StyleAndTextTuples:
        """渲染分页 Session 列表。"""

        page = self._session_page(overlay)
        page_count = (len(overlay.choices) + DEFAULT_PAGE_SIZE - 1) // DEFAULT_PAGE_SIZE
        fragments: StyleAndTextTuples = [
            ("class:header", " 切换 Session\n\n"),
        ]
        for index, choice in enumerate(page):
            cursor = "❯" if index == overlay.row_index else " "
            style = "class:selected" if index == overlay.row_index else ""
            fragments.append((style, f" {cursor} {choice.line}\n"))
        fragments.extend(
            [
                ("class:muted", f"\n 第 {overlay.page_index + 1}/{page_count} 页\n"),
                (
                    "class:muted",
                    " ↑↓ 页内选择 · PgUp/PgDn 或 p/n 翻页 · Enter 确认 · Esc 取消",
                ),
            ]
        )
        return fragments

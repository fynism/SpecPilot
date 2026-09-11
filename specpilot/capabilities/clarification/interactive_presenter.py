"""提供支持方向键选择和直接文字输入的澄清终端界面。"""

import sys
from dataclasses import dataclass

from prompt_toolkit.application import Application
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.formatted_text import StyleAndTextTuples
from prompt_toolkit.input import Input
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.keys import Keys
from prompt_toolkit.layout import HSplit, Layout, Window
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.processors import BeforeInput
from prompt_toolkit.output import Output
from prompt_toolkit.styles import Style

from specpilot.capabilities.clarification.models import ClarificationAnswer, ClarificationRequest
from specpilot.capabilities.clarification.tool import (
    ClarificationCancelled,
    ClarificationPresenter,
    ConsoleClarificationPresenter,
)


@dataclass
class _SelectionState:
    """保存界面当前高亮项和用户明确选中的选项。"""

    highlighted_index: int
    selected_index: int | None


class InteractiveClarificationPresenter:
    """使用终端原生按键完成选项选择、自由输入和取消。"""

    def __init__(self, input: Input | None = None, output: Output | None = None) -> None:
        """允许测试注入虚拟终端，生产环境默认使用当前标准输入输出。"""

        self._input = input
        self._output = output

    @staticmethod
    def _render_request(
        request: ClarificationRequest,
        state: _SelectionState,
    ) -> StyleAndTextTuples:
        """根据当前选择状态生成动态终端内容。"""

        fragments: StyleAndTextTuples = [
            ("class:question", f"{request.question}\n"),
            ("class:reason", f"为什么需要确认：{request.reason}\n\n"),
        ]
        for index, option in enumerate(request.options):
            cursor = "❯" if index == state.highlighted_index else " "
            selected = "●" if index == state.selected_index else "○"
            recommended = "  [推荐]" if option.id == request.recommended_option_id else ""
            fragments.append(("class:option", f"{cursor} {selected} {option.label}{recommended}\n"))
            fragments.append(("class:description", f"      {option.description}\n"))
        fragments.extend(
            [
                ("class:reason", f"\n推荐理由：{request.recommendation_reason}\n"),
                (
                    "class:help",
                    "↑↓ 选择 · Tab 选中/取消 · 直接输入回答或补充 · Enter 确认 · Esc 取消\n",
                ),
            ]
        )
        return fragments

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """显示交互界面，并等待用户明确提交选项、文字或二者组合。"""

        recommended_index = next(
            index
            for index, option in enumerate(request.options)
            if option.id == request.recommended_option_id
        )
        state = _SelectionState(recommended_index, recommended_index)
        answer_buffer = Buffer(
            multiline=False,
            read_only=not request.allow_custom_answer,
        )
        bindings = KeyBindings()

        @bindings.add("up")
        def select_previous(event: KeyPressEvent) -> None:
            """循环移动到上一个选项，并把它视为用户明确选择。"""

            state.highlighted_index = (state.highlighted_index - 1) % len(request.options)
            state.selected_index = state.highlighted_index
            event.app.invalidate()

        @bindings.add("down")
        def select_next(event: KeyPressEvent) -> None:
            """循环移动到下一个选项，并把它视为用户明确选择。"""

            state.highlighted_index = (state.highlighted_index + 1) % len(request.options)
            state.selected_index = state.highlighted_index
            event.app.invalidate()

        @bindings.add("tab")
        def toggle_selection(event: KeyPressEvent) -> None:
            """允许用户为文字补充显式附加或移除当前选项。"""

            if state.selected_index == state.highlighted_index:
                state.selected_index = None
            else:
                state.selected_index = state.highlighted_index
            event.app.invalidate()

        @bindings.add(Keys.Any)
        def insert_free_text(event: KeyPressEvent) -> None:
            """直接键入即开始自由回答，并取消尚未再次确认的默认推荐。"""

            if not request.allow_custom_answer:
                return
            state.selected_index = None
            answer_buffer.insert_text(event.data)
            event.app.invalidate()

        @bindings.add("enter")
        def submit(event: KeyPressEvent) -> None:
            """提交当前选择和非空文字，空输入时确认高亮选项。"""

            free_text = answer_buffer.text.strip() or None
            selected_index = state.selected_index
            if selected_index is None and free_text is None:
                selected_index = state.highlighted_index
            selected_option_id = (
                request.options[selected_index].id if selected_index is not None else None
            )
            event.app.exit(
                result=ClarificationAnswer(
                    request_id=request.request_id,
                    selected_option_id=selected_option_id,
                    free_text=free_text,
                )
            )

        @bindings.add("escape")
        @bindings.add("c-c")
        @bindings.add("c-d")
        def cancel(event: KeyPressEvent) -> None:
            """取消当前澄清，但不把推荐项误记成用户决定。"""

            event.app.exit(result=None)

        prompt = "直接回答或补充：" if request.allow_custom_answer else "当前问题仅接受选项"
        content = HSplit(
            [
                Window(
                    FormattedTextControl(
                        lambda: self._render_request(request, state),
                        focusable=False,
                    ),
                    height=Dimension(preferred=6 + len(request.options) * 2),
                    wrap_lines=True,
                ),
                Window(height=1, char="─", style="class:separator"),
                Window(
                    BufferControl(
                        buffer=answer_buffer,
                        input_processors=[BeforeInput(prompt)],
                    ),
                    height=1,
                ),
            ]
        )
        application: Application[ClarificationAnswer | None] = Application(
            layout=Layout(content, focused_element=content.children[-1]),
            key_bindings=bindings,
            style=Style.from_dict(
                {
                    "question": "bold ansicyan",
                    "reason": "ansibrightblack",
                    "option": "",
                    "description": "ansibrightblack",
                    "help": "ansibrightblack",
                    "separator": "ansibrightblack",
                    "prompt": "ansicyan",
                }
            ),
            full_screen=False,
            mouse_support=False,
            input=self._input,
            output=self._output,
        )
        try:
            answer = application.run()
        except (EOFError, KeyboardInterrupt) as exc:
            raise ClarificationCancelled from exc
        if answer is None:
            raise ClarificationCancelled
        return answer


def build_clarification_presenter() -> ClarificationPresenter:
    """交互终端使用键盘界面，重定向环境回退到逐行输入。"""

    # prompt_toolkit 需要真实 TTY 才能可靠处理方向键；管道、CI 和日志采集环境继续使用
    # 无控制序列的后备界面，避免启动后卡在无法操作的交互应用中。
    if sys.stdin.isatty() and sys.stdout.isatty():
        return InteractiveClarificationPresenter()
    return ConsoleClarificationPresenter()

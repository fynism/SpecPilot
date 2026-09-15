"""提供支持斜杠命令提示与 Tab 补全的 CLI 输入框。"""

import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Protocol, TextIO

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import CompleteEvent, Completer, Completion
from prompt_toolkit.document import Document
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.input import Input
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.output import Output
from prompt_toolkit.shortcuts.prompt import CompleteStyle
from prompt_toolkit.styles import Style


@dataclass(frozen=True)
class CommandDefinition:
    """定义一个可补全命令及其格式提示。"""

    name: str
    usage: str
    description: str


COMMANDS = (
    CommandDefinition("/new", "/new [标题]", "创建并切换到新 Session"),
    CommandDefinition("/sessions", "/sessions", "列出当前 worktree 的 Session"),
    CommandDefinition("/switch", "/switch [session-id]", "选择或直接切换 Session"),
    CommandDefinition("/rename", "/rename <标题>", "重命名当前 Session"),
    CommandDefinition("/status", "/status", "显示当前 Session 与 Spec 状态"),
    CommandDefinition("/done", "/done", "结束澄清并总结已有信息"),
    CommandDefinition("/quit", "/quit", "退出 SpecPilot"),
)


class CommandPrompt(Protocol):
    """定义 CLI 获取下一条用户输入所需的最小接口。"""

    def read(self) -> str:
        """读取一条命令或自然语言请求。"""


class SlashCommandCompleter(Completer):
    """仅在输入斜杠命令名称时提供格式和用途提示。"""

    def get_completions(
        self,
        document: Document,
        complete_event: CompleteEvent,
    ) -> Iterator[Completion]:
        """按当前命令前缀生成可由 Tab 接受的候选项。"""

        del complete_event
        prefix = document.text_before_cursor
        if not prefix.startswith("/") or any(character.isspace() for character in prefix):
            return
        for command in COMMANDS:
            if command.name.startswith(prefix.lower()):
                yield Completion(
                    command.name,
                    start_position=-len(prefix),
                    display=command.usage,
                    display_meta=command.description,
                )


class InteractiveCommandPrompt:
    """使用 prompt_toolkit 提供命令菜单、补全和进程内输入历史。"""

    def __init__(
        self,
        input: Input | None = None,
        output: Output | None = None,
    ) -> None:
        """允许测试注入虚拟终端输入输出。"""

        completer = SlashCommandCompleter()
        bindings = KeyBindings()

        @bindings.add("tab")
        def complete_command(event: KeyPressEvent) -> None:
            """唯一匹配时一次补全，多项匹配时在候选之间移动。"""

            buffer = event.current_buffer
            completions = list(
                completer.get_completions(
                    buffer.document,
                    CompleteEvent(completion_requested=True),
                )
            )
            if len(completions) == 1:
                # 默认 Tab 在候选已经弹出时只移动选择；命令输入需要一次按键即可完成唯一项。
                buffer.cancel_completion()
                buffer.apply_completion(completions[0])
            elif completions:
                if buffer.complete_state is None:
                    buffer.start_completion(select_first=True)
                else:
                    buffer.complete_next()

        self._session: PromptSession[str] = PromptSession(
            completer=completer,
            complete_while_typing=True,
            complete_style=CompleteStyle.COLUMN,
            reserve_space_for_menu=8,
            history=InMemoryHistory(),
            input=input,
            output=output,
            key_bindings=bindings,
            style=Style.from_dict({"prompt": "ansicyan"}),
        )

    def read(self) -> str:
        """读取输入；Tab 使用当前斜杠命令候选完成补全。"""

        return self._session.prompt([("class:prompt", "SpecPilot >> ")])


class ConsoleCommandPrompt:
    """为管道、CI 等非 TTY 环境保留普通逐行输入。"""

    def __init__(self, read: Callable[[str], str] = input) -> None:
        """允许测试注入逐行输入函数。"""

        self._read = read

    def read(self) -> str:
        """读取一条无控制序列的输入。"""

        return self._read("SpecPilot >> ")


def build_command_prompt(
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> CommandPrompt:
    """仅在输入输出均为 TTY 时启用 prompt_toolkit 输入框。"""

    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    if input_stream.isatty() and output_stream.isatty():
        return InteractiveCommandPrompt()
    return ConsoleCommandPrompt()

"""CLI 斜杠命令提示与 Tab 补全测试。"""

from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document
from prompt_toolkit.input.defaults import create_pipe_input
from prompt_toolkit.output import DummyOutput

from specpilot.integrations.terminal.command_prompt import (
    ConsoleCommandPrompt,
    InteractiveCommandPrompt,
    SlashCommandCompleter,
)


def completion_names(text: str) -> list[str]:
    """返回指定输入前缀下的补全文本。"""

    completer = SlashCommandCompleter()
    completions = completer.get_completions(
        Document(text, cursor_position=len(text)),
        CompleteEvent(completion_requested=True),
    )
    return [completion.text for completion in completions]


def test_slash_opens_command_candidates_with_prefix_filtering() -> None:
    """输入斜杠展示全部命令，继续输入后只保留匹配项。"""

    assert completion_names("/") == [
        "/new",
        "/sessions",
        "/switch",
        "/rename",
        "/status",
        "/done",
        "/quit",
    ]
    assert completion_names("/sw") == ["/switch"]
    assert completion_names("普通需求") == []
    assert completion_names("/switch ") == []


def test_command_candidate_exposes_usage_and_description() -> None:
    """补全菜单同时展示命令格式和用途，而不只显示命令名称。"""

    completer = SlashCommandCompleter()
    completions = list(
        completer.get_completions(
            Document("/sw", cursor_position=3),
            CompleteEvent(completion_requested=True),
        )
    )

    assert len(completions) == 1
    assert completions[0].display_text == "/switch [session-id]"
    assert completions[0].display_meta_text == "选择或直接切换 Session"


def test_interactive_prompt_accepts_unique_command_with_tab() -> None:
    """Tab 可以把唯一的命令前缀补全为完整命令。"""

    with create_pipe_input() as pipe_input:
        pipe_input.send_text("/sta\t\r")
        prompt = InteractiveCommandPrompt(pipe_input, DummyOutput())

        result = prompt.read()

    assert result == "/status"


def test_console_prompt_keeps_plain_line_input() -> None:
    """非 TTY 输入不依赖 prompt_toolkit 控制序列。"""

    prompts: list[str] = []

    def read(prompt: str) -> str:
        prompts.append(prompt)
        return "/status"

    command_prompt = ConsoleCommandPrompt(read)

    assert command_prompt.read() == "/status"
    assert prompts == ["SpecPilot >> "]

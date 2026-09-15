"""Session 终端选择器的排序、分页与回退行为测试。"""

from datetime import UTC, datetime, timedelta

from prompt_toolkit.input.defaults import create_pipe_input
from prompt_toolkit.output import DummyOutput

from specpilot.integrations.terminal.session_picker import (
    ConsoleSessionPicker,
    InteractiveSessionPicker,
    build_session_choices,
)
from specpilot.runtime.session.models import SessionRecord, create_session_record

NOW = datetime(2026, 9, 15, 8, 0, tzinfo=UTC)


def make_sessions(count: int) -> tuple[SessionRecord, ...]:
    """创建更新时间和消息数均可区分的 Session。"""

    sessions: list[SessionRecord] = []
    for index in range(count):
        timestamp = NOW + timedelta(seconds=index)

        def clock(timestamp: datetime = timestamp) -> datetime:
            """返回当前测试 Session 的固定更新时间。"""

            return timestamp

        def make_id(index: int = index) -> str:
            """返回符合持久化约束的确定性 Session ID。"""

            return f"SS-{index:012x}"

        session = create_session_record(
            f"话题 {index}",
            clock=clock,
            id_factory=make_id,
        )
        sessions.append(
            session.model_copy(
                update={
                    "messages": [
                        {"role": "user", "content": f"消息 {message_index}"}
                        for message_index in range(index)
                    ]
                }
            )
        )
    return tuple(sessions)


def test_choices_are_recent_first_and_include_required_fields() -> None:
    """展示行按更新时间倒序并包含短 ID、标题、状态、时间和消息数。"""

    sessions = make_sessions(3)

    choices = build_session_choices(sessions)

    assert [choice.session_id for choice in choices] == [
        sessions[2].session_id,
        sessions[1].session_id,
        sessions[0].session_id,
    ]
    assert choices[0].line == (
        "SS-00000002 · 话题 2 · waiting_for_user · 2026-09-15T08:00:02+00:00 · 2 条消息"
    )


def test_choices_remove_control_characters_from_titles() -> None:
    """Session 标题不能借助换行或 ANSI 控制字符改变终端输出。"""

    session = make_sessions(1)[0].model_copy(update={"title": "第一行\n\x1b[31m第二行"})

    choice = build_session_choices((session,))[0]

    assert "第一行 [31m第二行" in choice.line
    assert "\n" not in choice.line
    assert "\x1b" not in choice.line


def test_interactive_picker_opens_on_current_session_even_on_later_page() -> None:
    """当前 Session 位于后续页面时仍作为初始高亮项。"""

    sessions = make_sessions(12)
    with create_pipe_input() as pipe_input:
        pipe_input.send_text("\r")
        picker = InteractiveSessionPicker(pipe_input, DummyOutput())

        selected = picker.pick(sessions, sessions[0].session_id)

    assert selected == sessions[0].session_id


def test_interactive_picker_can_page_and_select_every_page() -> None:
    """n 翻到下一页后，方向键仍可选择该页的任意有效项。"""

    sessions = make_sessions(12)
    with create_pipe_input() as pipe_input:
        pipe_input.send_text("n\x1b[B\r")
        picker = InteractiveSessionPicker(pipe_input, DummyOutput())

        selected = picker.pick(sessions, sessions[-1].session_id)

    assert selected == sessions[0].session_id


def test_interactive_picker_supports_page_down_and_page_up_keys() -> None:
    """PgDn 与 PgUp 均可切页，并尽可能保留原页内位置。"""

    sessions = make_sessions(12)
    with create_pipe_input() as pipe_input:
        pipe_input.send_text("\x1b[6~\r")
        picker = InteractiveSessionPicker(pipe_input, DummyOutput())
        selected_after_page_down = picker.pick(sessions, sessions[-1].session_id)

    with create_pipe_input() as pipe_input:
        pipe_input.send_text("\x1b[5~\r")
        picker = InteractiveSessionPicker(pipe_input, DummyOutput())
        selected_after_page_up = picker.pick(sessions, sessions[0].session_id)

    assert selected_after_page_down == sessions[1].session_id
    assert selected_after_page_up == sessions[10].session_id


def test_interactive_picker_cancellation_does_not_confirm_highlight() -> None:
    """Ctrl+C 取消不会返回默认高亮 Session。"""

    sessions = make_sessions(2)
    with create_pipe_input() as pipe_input:
        pipe_input.send_text("\x03")
        picker = InteractiveSessionPicker(pipe_input, DummyOutput())

        selected = picker.pick(sessions, sessions[0].session_id)

    assert selected is None


def test_console_picker_prints_all_and_retries_until_valid_number() -> None:
    """非 TTY 回退一次性列出全部 Session，并拒绝空值和非法序号。"""

    sessions = make_sessions(12)
    answers = iter(("", "不是数字", "13", "12"))
    prompts: list[str] = []
    output: list[str] = []

    def read(prompt: str) -> str:
        prompts.append(prompt)
        return next(answers)

    picker = ConsoleSessionPicker(read, output.append)
    selected = picker.pick(sessions, sessions[-1].session_id)

    assert selected == sessions[0].session_id
    assert len([line for line in output if line[:1].isdigit()]) == 12
    assert len(prompts) == 4
    assert output.count("请输入 1 到 12 之间的有效序号。") == 3
    assert not any("页" in line for line in output)


def test_console_picker_treats_escape_and_control_c_as_cancellation() -> None:
    """非 TTY 回退的 Esc 与 Ctrl+C 都返回取消结果。"""

    sessions = make_sessions(1)
    escape_picker = ConsoleSessionPicker(lambda _: "\x1b", lambda _: None)

    def interrupt(_: str) -> str:
        raise KeyboardInterrupt

    interrupted_picker = ConsoleSessionPicker(interrupt, lambda _: None)

    assert escape_picker.pick(sessions, sessions[0].session_id) is None
    assert interrupted_picker.pick(sessions, sessions[0].session_id) is None

"""键盘式澄清界面的终端交互测试。"""

from prompt_toolkit.input.defaults import create_pipe_input
from prompt_toolkit.output import DummyOutput

from specpilot.capabilities.clarification.interactive_presenter import (
    InteractiveClarificationPresenter,
)
from specpilot.capabilities.clarification.models import (
    ClarificationOption,
    ClarificationRequest,
)


def make_request() -> ClarificationRequest:
    """创建带推荐项的固定澄清请求。"""

    return ClarificationRequest(
        question="谁可以导出？",
        reason="该选择会改变权限边界。",
        options=[
            ClarificationOption(
                id="admin_only",
                label="仅管理员",
                description="保持现有权限边界。",
            ),
            ClarificationOption(
                id="all_users",
                label="所有用户",
                description="允许普通用户导出。",
            ),
        ],
        recommended_option_id="admin_only",
        recommendation_reason="与当前权限模型一致。",
    )


def test_enter_confirms_the_highlighted_recommendation() -> None:
    """未输入文字时，回车明确确认初始高亮的推荐项。"""

    with create_pipe_input() as pipe_input:
        pipe_input.send_text("\r")
        presenter = InteractiveClarificationPresenter(pipe_input, DummyOutput())
        answer = presenter.ask(make_request())

    assert answer.selected_option_id == "admin_only"
    assert answer.free_text is None


def test_arrow_key_selects_another_option() -> None:
    """方向键移动后，回车提交新选中的选项。"""

    with create_pipe_input() as pipe_input:
        pipe_input.send_text("\x1b[B\r")
        presenter = InteractiveClarificationPresenter(pipe_input, DummyOutput())
        answer = presenter.ask(make_request())

    assert answer.selected_option_id == "all_users"
    assert answer.free_text is None


def test_typing_directly_submits_a_free_text_answer() -> None:
    """直接键入文字会取消隐含推荐，形成纯自由回答。"""

    with create_pipe_input() as pipe_input:
        pipe_input.send_text("管理员和项目所有者\r")
        presenter = InteractiveClarificationPresenter(pipe_input, DummyOutput())
        answer = presenter.ask(make_request())

    assert answer.selected_option_id is None
    assert answer.free_text == "管理员和项目所有者"


def test_text_can_be_attached_to_an_explicit_option() -> None:
    """输入补充后可用方向键重新选定一个选项并一并提交。"""

    with create_pipe_input() as pipe_input:
        pipe_input.send_text("需要记录审计日志\x1b[B\r")
        presenter = InteractiveClarificationPresenter(pipe_input, DummyOutput())
        answer = presenter.ask(make_request())

    assert answer.selected_option_id == "all_users"
    assert answer.free_text == "需要记录审计日志"

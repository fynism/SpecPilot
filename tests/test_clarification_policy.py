"""澄清终止边界的确定性识别测试。"""

import pytest

from specpilot.capabilities.clarification.models import ClarificationAnswer
from specpilot.capabilities.clarification.policy import (
    ClarificationStopController,
    is_clarification_stop_request,
)


@pytest.mark.parametrize(
    "text",
    [
        "/done",
        "到此为止",
        " 到此为止。 ",
        "好的，到此为止",
        "先到这里！",
        "停止澄清",
        "不用再问了",
    ],
)
def test_explicit_stop_requests_are_recognized(text: str) -> None:
    """明确结束语会关闭下一轮的工具能力。"""

    assert is_clarification_stop_request(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "不要到此为止",
        "到此为止以后还要导出",
        "这个功能到此为止了吗",
        "继续澄清",
        "帮我导出",
    ],
)
def test_ambiguous_or_extended_sentences_do_not_trigger_stop(text: str) -> None:
    """保守匹配避免从普通需求描述中误判结束意图。"""

    assert is_clarification_stop_request(text) is False


def test_controller_consumes_a_stop_answer_once() -> None:
    """澄清界面的结束回答只控制紧随其后的总结轮。"""

    controller = ClarificationStopController()
    controller.observe_answer(
        ClarificationAnswer(
            request_id="Q-123456789abc",
            free_text="到此为止",
        )
    )

    assert controller.requested is True
    assert controller.consume_request() is True
    assert controller.requested is False
    assert controller.consume_request() is False

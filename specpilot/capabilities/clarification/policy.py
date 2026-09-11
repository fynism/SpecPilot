"""定义用户主动结束需求澄清时使用的确定性边界。"""

import re
from dataclasses import dataclass

from specpilot.capabilities.clarification.models import ClarificationAnswer, ClarificationRequest

_STOP_REQUESTS = frozenset(
    {
        "/done",
        "到此为止",
        "先到这里",
        "暂时到这里",
        "今天先到这里",
        "结束澄清",
        "停止澄清",
        "不用再问了",
        "不需要继续澄清",
    }
)
_ACKNOWLEDGEMENTS = frozenset({"好", "好的", "可以", "嗯", "嗯嗯"})


def _normalize_user_text(text: str) -> str:
    """折叠空白和常见标点，供显式短指令进行保守匹配。"""

    without_punctuation = re.sub(r"[，,。.!！?？；;：:]+", " ", text.strip().casefold())
    return " ".join(without_punctuation.split())


def is_clarification_stop_request(text: str) -> bool:
    """仅在用户给出明确、完整的结束表达时返回真。"""

    normalized = _normalize_user_text(text)
    if normalized in _STOP_REQUESTS:
        return True
    parts = normalized.split(maxsplit=1)
    return len(parts) == 2 and parts[0] in _ACKNOWLEDGEMENTS and parts[1] in _STOP_REQUESTS


@dataclass
class ClarificationStopController:
    """把澄清界面中的结束回答传递给当前 Agent Loop。"""

    _requested: bool = False

    @property
    def requested(self) -> bool:
        """返回是否已有尚未消费的结束请求。"""

        return self._requested

    def observe_answer(self, answer: ClarificationAnswer) -> None:
        """只把用户自由输入中的明确结束表达提升为控制信号。"""

        if answer.free_text is not None and is_clarification_stop_request(answer.free_text):
            self._requested = True

    def observe_answer_event(
        self,
        _request: ClarificationRequest,
        answer: ClarificationAnswer,
    ) -> None:
        """接收已通过服务复验的 ClarificationAnswered Hook 事件。"""

        self.observe_answer(answer)

    def consume_request(self) -> bool:
        """读取并清除信号，确保它只控制紧随其后的最终总结。"""

        requested = self._requested
        self._requested = False
        return requested

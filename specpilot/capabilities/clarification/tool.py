"""提供独立于 Agent Loop 和终端实现的结构化需求澄清 HITL。"""

from collections.abc import Callable
from typing import Protocol

from specpilot.capabilities.clarification.models import (
    ClarificationAnswer,
    ClarificationOutcome,
    ClarificationRequest,
    RequestClarificationInput,
)


class ClarificationCancelled(Exception):
    """表示用户主动取消了一次需求澄清。"""


class ClarificationPresenter(Protocol):
    """展示一次澄清请求，并返回用户亲自确认的答案。"""

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """同步等待用户回答；用户取消时抛出取消异常。"""


class ConsoleClarificationPresenter:
    """供非交互终端使用的无依赖数字选择界面。"""

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """渲染数字选项；用户按回车可主动确认推荐项。"""

        print(f"\n\033[36m{request.question}\033[0m")
        print(f"\033[90m为什么需要确认：{request.reason}\033[0m\n")

        # 推荐项只决定默认光标位置，不能绕过用户确认直接成为答案。
        recommended_number = 0
        for index, option in enumerate(request.options, start=1):
            recommended = option.id == request.recommended_option_id
            if recommended:
                recommended_number = index
            suffix = "  [推荐]" if recommended else ""
            print(f"  {index}. {option.label}{suffix}")
            print(f"     {option.description}")

        print(f"\n推荐理由：{request.recommendation_reason}")

        # 输入无效时保持在当前问题内，避免把错误输入传给模型后污染需求事实。
        while True:
            try:
                prompt = f"请选择 [{recommended_number}]"
                if request.allow_custom_answer:
                    prompt += "，或直接输入回答"
                raw_choice = input(f"{prompt}；输入 q 取消：").strip()
            except (EOFError, KeyboardInterrupt) as exc:
                raise ClarificationCancelled from exc

            if raw_choice.casefold() in {"q", "quit", "cancel"}:
                raise ClarificationCancelled
            # 空输入代表用户主动按下回车确认推荐项，而不是系统自动采用默认值。
            if raw_choice == "":
                selected_number = recommended_number
            elif raw_choice.isdigit():
                selected_number = int(raw_choice)
            else:
                if request.allow_custom_answer:
                    return ClarificationAnswer(
                        request_id=request.request_id,
                        free_text=raw_choice,
                    )
                print("请输入选项编号、按回车确认推荐项，或输入 q 取消。")
                continue

            if 1 <= selected_number <= len(request.options):
                selected = request.options[selected_number - 1]
                return ClarificationAnswer(
                    request_id=request.request_id,
                    selected_option_id=selected.id,
                )

            print("请选择列表中的有效选项。")


class ClarificationService:
    """校验、展示并记录一次需求澄清的完整生命周期。"""

    def __init__(
        self,
        presenter: ClarificationPresenter,
        event_dispatcher: Callable[..., object] | None = None,
    ) -> None:
        """注入交互界面边界和可选的事件分发器。"""

        self._presenter = presenter
        self._dispatch = event_dispatcher or (lambda *_args: None)

    def request(self, tool_input: RequestClarificationInput) -> str:
        """展示模型提出的澄清请求，并返回 JSON 工具结果。"""

        # request_id 由可信运行时代码生成，不能依赖模型生成唯一且稳定的标识。
        request = ClarificationRequest.model_validate(tool_input.model_dump())
        self._dispatch("ClarificationRequested", request)
        try:
            answer = self._presenter.ask(request)
        except ClarificationCancelled:
            outcome = ClarificationOutcome(
                status="cancelled",
                request_id=request.request_id,
            )
            self._dispatch("ClarificationCancelled", request)
            return outcome.model_dump_json()

        # Presenter 属于系统边界，即使通过 Protocol 注入也必须复验其返回结果，避免
        # 错误实现返回未展示的选项、跨请求答案或未经允许的自定义内容。
        valid_option_ids = {option.id for option in request.options}
        if (
            answer.selected_option_id is not None
            and answer.selected_option_id not in valid_option_ids
        ):
            raise ValueError("交互界面返回了未向用户展示的选项")
        if answer.free_text is not None and not request.allow_custom_answer:
            raise ValueError("当前问题不允许自由输入，但交互界面返回了文字内容")
        if answer.request_id != request.request_id:
            raise ValueError("交互界面返回了属于其他澄清请求的答案")

        outcome = ClarificationOutcome(
            status="answered",
            request_id=request.request_id,
            answer=answer,
        )
        # 只有通过请求归属、选项范围和自由输入权限复验后，才发布已回答事件。
        self._dispatch("ClarificationAnswered", request, answer)
        return outcome.model_dump_json()

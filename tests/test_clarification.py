"""Behavior tests for the structured Clarification HITL boundary."""

from collections.abc import Iterable
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from specpilot.capabilities.clarification.models import (
    ClarificationAnswer,
    ClarificationOption,
    ClarificationRequest,
    RequestClarificationInput,
)
from specpilot.capabilities.clarification.tool import (
    ClarificationCancelled,
    ClarificationService,
    ConsoleClarificationPresenter,
)
from specpilot.tooling.catalog import build_default_registry
from specpilot.tooling.executor import ToolExecutor


def make_input(**overrides: object) -> RequestClarificationInput:
    """Build a valid request input with focused test overrides."""

    values: dict[str, object] = {
        "question": "Who can export data?",
        "reason": "The answer changes the authorization boundary.",
        "options": [
            ClarificationOption(
                id="admin_only",
                label="Administrators only",
                description="Preserves the existing access boundary.",
            ),
            ClarificationOption(
                id="all_users",
                label="All users",
                description="Expands data access to ordinary users.",
            ),
        ],
        "recommended_option_id": "admin_only",
        "recommendation_reason": "It matches the current authorization model.",
        "allow_custom_answer": True,
    }
    values.update(overrides)
    return RequestClarificationInput.model_validate(values)


class QueuePresenter:
    """Return scripted choices while capturing requests shown to the user."""

    def __init__(self, choices: Iterable[str]) -> None:
        self._choices = iter(choices)
        self.requests: list[ClarificationRequest] = []

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """Select the next scripted option for this request."""

        self.requests.append(request)
        return ClarificationAnswer(
            request_id=request.request_id,
            selected_option_id=next(self._choices),
        )


class CancellingPresenter:
    """Always represent an explicit user cancellation."""

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """Cancel instead of answering."""

        raise ClarificationCancelled


def test_request_requires_unique_options() -> None:
    """Duplicate option IDs are rejected before reaching the presenter."""

    duplicate_options = [
        ClarificationOption(id="same", label="First", description="First choice."),
        ClarificationOption(id="same", label="Second", description="Second choice."),
    ]

    with pytest.raises(ValidationError, match="option IDs must be unique"):
        make_input(options=duplicate_options)


def test_recommendation_must_reference_an_offered_option() -> None:
    """A model cannot recommend an option the user cannot select."""

    with pytest.raises(ValidationError, match="must reference an existing option"):
        make_input(recommended_option_id="missing")


def test_service_can_ask_repeatedly_with_the_same_tool() -> None:
    """One service supports sequential clarification calls in a traditional loop."""

    presenter = QueuePresenter(["admin_only", "all_users"])
    events: list[str] = []
    service = ClarificationService(
        presenter,
        lambda event, *_args: events.append(event),
    )

    first_result = service.request(make_input())
    second_result = service.request(make_input())

    assert '"status":"answered"' in first_result
    assert '"selected_option_id":"admin_only"' in first_result
    assert '"selected_option_id":"all_users"' in second_result
    assert len({request.request_id for request in presenter.requests}) == 2
    assert events == [
        "ClarificationRequested",
        "ClarificationAnswered",
        "ClarificationRequested",
        "ClarificationAnswered",
    ]


def test_cancellation_does_not_create_an_answer() -> None:
    """Cancellation is explicit and never substitutes the recommended option."""

    events: list[str] = []
    service = ClarificationService(
        CancellingPresenter(),
        lambda event, *_args: events.append(event),
    )

    result = service.request(make_input())

    assert '"status":"cancelled"' in result
    assert '"answer":null' in result
    assert events == ["ClarificationRequested", "ClarificationCancelled"]


def test_answer_can_combine_an_option_with_free_text() -> None:
    """用户可以选择方向并补充不能被预设选项表达的约束。"""

    answer = ClarificationAnswer(
        request_id="Q-123456789abc",
        selected_option_id="admin_only",
        free_text="但项目所有者也可以授权一次性导出。",
    )

    assert answer.selected_option_id == "admin_only"
    assert answer.free_text == "但项目所有者也可以授权一次性导出。"


def test_answer_requires_an_option_or_free_text() -> None:
    """空提交不能被记录成用户已经回答。"""

    with pytest.raises(ValidationError, match="selected_option_id, free_text, or both"):
        ClarificationAnswer(request_id="Q-123456789abc")


def test_console_enter_confirms_the_recommended_option() -> None:
    """The default is convenient but still requires an explicit Enter press."""

    request = ClarificationRequest.model_validate(make_input().model_dump())

    with patch("builtins.input", return_value=""):
        answer = ConsoleClarificationPresenter().ask(request)

    assert answer.selected_option_id == "admin_only"
    assert answer.source == "user"


def test_console_accepts_free_text_without_an_other_option() -> None:
    """后备界面允许用户直接键入回答，不要求先选择“其他”。"""

    request = ClarificationRequest.model_validate(make_input().model_dump())

    with patch("builtins.input", return_value="管理员和项目所有者"):
        answer = ConsoleClarificationPresenter().ask(request)

    assert answer.selected_option_id is None
    assert answer.free_text == "管理员和项目所有者"


def test_registered_tool_returns_the_presenter_choice() -> None:
    """Clarification follows the same Registry and ToolExecutor path as other tools."""

    presenter = QueuePresenter(["admin_only"])
    registry = build_default_registry(presenter)
    executor = ToolExecutor(registry, lambda *_args: None)

    output = executor.execute("request_clarification", make_input().model_dump())

    assert '"status":"answered"' in output
    assert '"selected_option_id":"admin_only"' in output

"""SpecPilot 全屏 TUI 的终端与 Session 集成测试。"""

from collections.abc import Callable
from pathlib import Path
from threading import Thread
from time import monotonic, sleep
from typing import Any

from prompt_toolkit.input.defaults import create_pipe_input
from prompt_toolkit.output import DummyOutput

from specpilot.capabilities.clarification.models import (
    ClarificationAnswer,
    ClarificationOption,
    ClarificationRequest,
)
from specpilot.capabilities.clarification.tool import ClarificationPresenter
from specpilot.cli import SessionCommandResult, handle_session_command
from specpilot.integrations.filesystem.session_store import LocalSessionStore
from specpilot.integrations.terminal.tui import (
    AgentRunner,
    ClarificationWaiter,
    FullScreenTui,
    TuiClarificationPresenter,
)
from specpilot.runtime.hooks import HookRegistry
from specpilot.runtime.session.manager import SessionManager


class IdleRuntime:
    """为纯终端测试提供不会访问模型的 Agent Runtime。"""

    def __init__(self) -> None:
        self._hooks = HookRegistry()

    @property
    def hooks(self) -> HookRegistry:
        """返回空 Hook 注册表。"""

        return self._hooks

    def run(
        self,
        messages: list[dict[str, Any]],
        *,
        tools_enabled: bool = True,
    ) -> str:
        """测试不应触发模型运行。"""

        del messages, tools_enabled
        raise AssertionError("纯 TUI 命令测试不应运行 Agent Loop")


def make_manager(tmp_path: Path) -> SessionManager:
    """创建可预测 ID 的本地 SessionManager。"""

    ids = iter(("SS-000000000001", "SS-000000000002"))
    manager = SessionManager(LocalSessionStore(tmp_path), id_factory=lambda: next(ids))
    manager.start()
    return manager


def make_tui(
    manager: SessionManager,
    pipe_input: Any,
    runtime_builder: Callable[[ClarificationPresenter], AgentRunner] | None = None,
) -> FullScreenTui:
    """装配不连接真实模型的全屏 TUI。"""

    runtime = IdleRuntime()

    def runtime_factory(
        presenter: ClarificationPresenter,
        event_sink: Callable[[str], None],
    ) -> AgentRunner:
        del event_sink
        if runtime_builder is not None:
            return runtime_builder(presenter)
        return runtime

    def command_handler(
        query: str,
        emit: Callable[[str], None],
    ) -> SessionCommandResult:
        return handle_session_command(query, manager, emit)

    return FullScreenTui(
        manager,
        runtime_factory,
        command_handler,
        lambda _query: True,
        input=pipe_input,
        output=DummyOutput(),
    )


def test_tui_runs_as_full_screen_application_and_quits(tmp_path: Path) -> None:
    """TTY 入口使用 alternate screen Application，并能通过 /quit 恢复终端。"""

    manager = make_manager(tmp_path)
    with create_pipe_input() as pipe_input:
        pipe_input.send_text("/quit\r")
        tui = make_tui(manager, pipe_input)

        assert bool(tui.application.full_screen) is True
        tui.run()


def test_tui_session_picker_switches_without_nested_application(tmp_path: Path) -> None:
    """Session 选择作为同一全屏 Application 内的浮层完成。"""

    manager = make_manager(tmp_path)
    first_id = manager.current.session_id
    manager.create("第二个对话")
    with create_pipe_input() as pipe_input:
        # 当前 Session 在最近列表首项；向下选择旧 Session，确认后退出。
        pipe_input.send_text("/switch\r\x1b[B\r/quit\r")
        tui = make_tui(manager, pipe_input)

        tui.run()

    assert manager.current.session_id == first_id


def test_tui_runs_agent_loop_in_worker_and_persists_completed_turn(tmp_path: Path) -> None:
    """模型轮次不会退出全屏 Application，完成后重新接受命令。"""

    manager = make_manager(tmp_path)
    session_id = manager.current.session_id

    class AnsweringRuntime:
        """立即追加一个供应商无关文本响应。"""

        def __init__(self) -> None:
            self._hooks = HookRegistry()

        @property
        def hooks(self) -> HookRegistry:
            return self._hooks

        def run(
            self,
            messages: list[dict[str, Any]],
            *,
            tools_enabled: bool = True,
        ) -> str:
            del tools_enabled
            messages.append(
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "已收到需求。"}],
                }
            )
            return "model_complete"

    store = LocalSessionStore(tmp_path)
    with create_pipe_input() as pipe_input:
        tui = make_tui(manager, pipe_input, lambda _presenter: AnsweringRuntime())

        def drive_input() -> None:
            pipe_input.send_text("整理导出需求\r")
            deadline = monotonic() + 3
            while monotonic() < deadline:
                if (
                    store.load(session_id).status == "waiting_for_user"
                    and store.load(session_id).messages
                    and not tui.is_running_agent
                ):
                    pipe_input.send_text("/quit\r")
                    return
                sleep(0.01)
            pipe_input.send_text("/quit\r")

        driver = Thread(target=drive_input, daemon=True)
        driver.start()
        tui.run()
        driver.join(timeout=1)

    restored = store.load(session_id)
    assert restored.status == "waiting_for_user"
    assert restored.messages[-1]["content"][0]["text"] == "已收到需求。"


def test_tui_clarification_presenter_bridges_sync_worker_answer() -> None:
    """同步 Presenter 可以从 TUI 回调取得经过请求 ID 绑定的答案。"""

    request = ClarificationRequest(
        question="谁可以导出？",
        reason="该选择影响权限边界。",
        options=[
            ClarificationOption(
                id="admin_only",
                label="仅管理员",
                description="保持当前权限模型。",
            ),
            ClarificationOption(
                id="all_users",
                label="所有用户",
                description="扩大导出权限。",
            ),
        ],
        recommended_option_id="admin_only",
        recommendation_reason="最小权限原则。",
    )

    def answer_from_tui(
        request: ClarificationRequest,
        waiter: ClarificationWaiter,
    ) -> None:
        waiter.submit(
            ClarificationAnswer(
                request_id=request.request_id,
                selected_option_id="admin_only",
            )
        )

    presenter = TuiClarificationPresenter(answer_from_tui)

    answer = presenter.ask(request)

    assert answer.request_id == request.request_id
    assert answer.selected_option_id == "admin_only"


def test_tui_clarification_overlay_answers_worker_without_nested_app(tmp_path: Path) -> None:
    """Agent Worker 可等待全屏浮层回答，并在同一 Loop 中继续完成。"""

    manager = make_manager(tmp_path)
    request = ClarificationRequest(
        question="选择导出权限",
        reason="该选择影响权限边界。",
        options=[
            ClarificationOption(
                id="admin_only",
                label="仅管理员",
                description="保持当前权限模型。",
            ),
            ClarificationOption(
                id="all_users",
                label="所有用户",
                description="扩大导出权限。",
            ),
        ],
        recommended_option_id="admin_only",
        recommendation_reason="最小权限原则。",
    )

    class ClarifyingRuntime:
        """在一次 Agent Loop 中同步等待 TUI 澄清答案。"""

        def __init__(self, presenter: ClarificationPresenter) -> None:
            self._presenter = presenter
            self._hooks = HookRegistry()

        @property
        def hooks(self) -> HookRegistry:
            return self._hooks

        def run(
            self,
            messages: list[dict[str, Any]],
            *,
            tools_enabled: bool = True,
        ) -> str:
            del tools_enabled
            answer = self._presenter.ask(request)
            messages.append(
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "text",
                            "text": f"已选择 {answer.selected_option_id}",
                        }
                    ],
                }
            )
            return "model_complete"

    with create_pipe_input() as pipe_input:
        tui = make_tui(
            manager,
            pipe_input,
            lambda presenter: ClarifyingRuntime(presenter),
        )

        def drive_clarification() -> None:
            pipe_input.send_text("增加导出功能\r")
            deadline = monotonic() + 3
            while monotonic() < deadline and not tui.has_active_overlay:
                sleep(0.01)
            pipe_input.send_text("\x1b[B\r")
            while monotonic() < deadline and tui.is_running_agent:
                sleep(0.01)
            pipe_input.send_text("/quit\r")

        driver = Thread(target=drive_clarification, daemon=True)
        driver.start()
        tui.run()
        driver.join(timeout=1)

    assert manager.current.messages[-1]["content"][0]["text"] == "已选择 all_users"

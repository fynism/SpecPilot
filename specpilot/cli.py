"""提供当前 Agent Demo 的交互式命令行界面。

当前职责：
    读取用户输入、触发提交 Hook、调用 Agent Loop，并输出模型最终文本。CLI 只负责
    表现层交互，不实现工具、权限或推理逻辑。

后续扩展：
    可以增加子命令、会话选择、恢复 checkpoint、结构化 HITL 选项和流式输出；同一
    Agent Runtime 未来也能被 Web 或服务端接口复用。
"""

from collections.abc import Callable
from typing import Any, Literal

try:
    import readline

    # readline 只影响终端编辑体验；Windows 不提供该模块时继续正常运行。
    bind = getattr(readline, "parse_and_bind", None)
    if callable(bind):
        bind("set bind-tty-special-chars off")
        bind("set input-meta on")
        bind("set output-meta on")
        bind("set convert-meta off")
except ImportError:
    pass

from specpilot.capabilities.clarification.policy import is_clarification_stop_request
from specpilot.config import WORKSPACE_ROOT, Settings, load_settings
from specpilot.integrations.anthropic.model import AnthropicModelClient
from specpilot.integrations.filesystem.session_store import LocalSessionStore
from specpilot.integrations.terminal.session_picker import SessionPicker, build_session_picker
from specpilot.runtime.agent import AgentRuntime, build_agent_runtime
from specpilot.runtime.model import ModelClient
from specpilot.runtime.session.manager import SessionManager
from specpilot.runtime.session.store import SessionNotFoundError, SessionStorageError

SessionCommandResult = Literal["not_command", "handled", "session_changed", "quit"]


def print_final_response(history: list[dict[str, Any]]) -> None:
    """从最后一条消息中提取并打印模型的文本块。"""
    response_content = history[-1]["content"]
    if isinstance(response_content, list):
        for block in response_content:
            if isinstance(block, dict) and block.get("type") == "text":
                print(block.get("text", ""))


def print_session_status(
    manager: SessionManager,
    emit: Callable[[str], None] = print,
) -> None:
    """显示当前 Session 与其独占 Spec 的概要。"""

    session = manager.current
    spec = manager.current_spec()
    emit(
        f"当前 Session：{session.session_id} · {session.title} · {session.status}\n"
        f"当前 Spec：{spec.spec_id} · v{spec.version} · {spec.status}"
    )


def handle_session_command(
    query: str,
    manager: SessionManager,
    emit: Callable[[str], None] = print,
    *,
    session_picker: SessionPicker | None = None,
) -> SessionCommandResult:
    """处理只允许在 Agent Loop 轮次之间执行的 Session 命令。"""

    stripped = query.strip()
    if not stripped.startswith("/") or stripped.lower() == "/done":
        return "not_command"

    command, *arguments = stripped.split(maxsplit=1)
    argument = arguments[0].strip() if arguments else ""
    command = command.lower()

    if command == "/quit":
        return "quit"
    if command == "/new":
        session = manager.create(argument or "新对话")
        emit(f"已创建并切换到 Session：{session.session_id} · {session.title}")
        return "session_changed"
    if command == "/sessions":
        active_id = manager.current.session_id
        for session in manager.list_sessions():
            marker = "*" if session.session_id == active_id else " "
            emit(f"{marker} {session.session_id} · {session.title} · {session.status}")
        return "handled"
    if command == "/switch":
        if not argument:
            picker = session_picker or build_session_picker()
            selected_session_id = picker.pick(
                manager.list_sessions(),
                manager.current.session_id,
            )
            if selected_session_id is None:
                return "handled"
            argument = selected_session_id
        try:
            session = manager.switch(argument)
        except (SessionNotFoundError, SessionStorageError) as exc:
            emit(f"无法切换 Session：{exc}")
            return "handled"
        emit(f"已切换到 Session：{session.session_id} · {session.title}")
        if session.status == "interrupted":
            emit("该 Session 的上一轮未完整结束，系统不会自动重放模型或工具调用。")
        return "session_changed"
    if command == "/rename":
        if not argument:
            emit("用法：/rename <标题>")
            return "handled"
        session = manager.rename(argument)
        emit(f"Session 已重命名为：{session.title}")
        return "handled"
    if command == "/status":
        print_session_status(manager, emit)
        return "handled"

    emit(f"未知命令：{command}")
    return "handled"


def build_session_runtime(
    manager: SessionManager,
    settings: Settings,
    client: ModelClient | None = None,
) -> AgentRuntime:
    """为当前 Session 装配独占 Spec 与澄清状态的 Agent Runtime。"""

    runtime_client = client or AnthropicModelClient(
        api_key=settings.api_key,
        model=settings.model,
        base_url=settings.base_url,
    )
    return build_agent_runtime(
        client=runtime_client,
        workspace_root=WORKSPACE_ROOT,
        spec_tools=manager.spec_tools,
        max_tool_use_turns=settings.max_tool_use_turns,
    )


def main() -> None:
    """启动可以创建、切换并恢复多个本地 Session 的交互式 CLI。"""
    try:
        # CLI 启动时明确校验配置；导入 Agent 模块和离线测试不需要真实密钥。
        settings = load_settings()
    except RuntimeError as exc:
        print(f"配置错误：{exc}")
        return

    manager = SessionManager(LocalSessionStore(WORKSPACE_ROOT))
    try:
        session = manager.start()
    except SessionStorageError as exc:
        # 损坏状态不能被静默替换为空对话，否则用户可能在不知情时覆盖原始数据。
        print(f"Session 恢复失败：{exc}")
        return
    runtime = build_session_runtime(manager, settings)
    session_picker = build_session_picker()

    print("SpecPilot: 通过结构化澄清帮助你定义软件需求")
    print("输入需求并按 Enter 发送；输入 /sessions 查看对话，输入 /done 结束澄清。")
    print(f"已恢复 Session：{session.session_id} · {session.title}")
    if session.status == "interrupted":
        print("上一轮未完整结束，系统不会自动重放模型或工具调用。")
    print()

    while True:
        try:
            query = input("\033[36mSpecPilot >> \033[0m")
        except (EOFError, KeyboardInterrupt):
            break

        if query.strip().lower() in ("q", "exit", ""):
            break

        command_result = handle_session_command(
            query,
            manager,
            session_picker=session_picker,
        )
        if command_result == "quit":
            break
        if command_result == "session_changed":
            runtime = build_session_runtime(manager, settings)
            print()
            continue
        if command_result == "handled":
            print()
            continue

        # 用户输入先经过 Hook，轮次限制或未来的上下文注入可以在调用模型前介入。
        hook_result = runtime.hooks.trigger("UserPromptSubmit", manager.messages, query)
        if hook_result == "stop":
            break

        manager.begin_turn(query)
        # 用户主动结束澄清时只允许模型基于已有上下文总结；本轮不再暴露或执行工具。
        tools_enabled = not is_clarification_stop_request(query)
        try:
            stop_reason = runtime.run(manager.messages, tools_enabled=tools_enabled)
        except KeyboardInterrupt:
            manager.interrupt_turn()
            runtime = build_session_runtime(manager, settings)
            print("\n当前轮次已中断并保存；系统不会自动重放模型或工具调用。")
            continue
        except Exception as exc:
            manager.interrupt_turn()
            runtime = build_session_runtime(manager, settings)
            # 外部 SDK 异常文本可能携带请求数据；CLI 只显示异常类型，完整诊断以后进入脱敏日志。
            print(f"Agent 运行失败：{type(exc).__name__}。当前轮次已标记为中断。")
            continue

        manager.complete_turn()
        if stop_reason == "max_tool_use_turns":
            print("本轮已达到工具调用轮次上限。已有结果已保留，你可以继续下一轮对话。")
        else:
            print_final_response(manager.messages)
        print()


if __name__ == "__main__":
    main()

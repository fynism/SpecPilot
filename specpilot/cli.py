"""提供当前 Agent Demo 的交互式命令行界面。

当前职责：
    读取用户输入、触发提交 Hook、调用 Agent Loop，并输出模型最终文本。CLI 只负责
    表现层交互，不实现工具、权限或推理逻辑。

后续扩展：
    可以增加子命令、会话选择、恢复 checkpoint、结构化 HITL 选项和流式输出；同一
    Agent Runtime 未来也能被 Web 或服务端接口复用。
"""

from typing import Any

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
from specpilot.config import load_settings
from specpilot.runtime.agent import HOOKS, agent_loop


def print_final_response(history: list[dict[str, Any]]) -> None:
    """从最后一条消息中提取并打印模型的文本块。"""
    response_content = history[-1]["content"]
    if isinstance(response_content, list):
        for block in response_content:
            if isinstance(block, dict) and block.get("type") == "text":
                print(block.get("text", ""))


def main() -> None:
    """启动交互会话并在多次用户输入之间保留消息历史。"""
    try:
        # CLI 启动时明确校验配置；导入 Agent 模块和离线测试不需要真实密钥。
        load_settings()
    except RuntimeError as exc:
        print(f"配置错误：{exc}")
        return

    print("SpecPilot: 通过结构化澄清帮助你定义软件需求")
    print("输入需求并按 Enter 发送；输入 /done 结束澄清，输入 q 退出。\n")

    # history 是当前 CLI 会话的多轮模型上下文；结构化 Spec 状态将独立维护。
    history: list[dict[str, Any]] = []
    while True:
        try:
            query = input("\033[36mSpecPilot >> \033[0m")
        except (EOFError, KeyboardInterrupt):
            break

        if query.strip().lower() in ("q", "exit", ""):
            break

        # 用户输入先经过 Hook，轮次限制或未来的上下文注入可以在调用模型前介入。
        hook_result = HOOKS.trigger("UserPromptSubmit", history, query)
        if hook_result == "stop":
            break

        history.append({"role": "user", "content": query})
        # 用户主动结束澄清时只允许模型基于已有上下文总结；本轮不再暴露或执行工具。
        tools_enabled = not is_clarification_stop_request(query)
        stop_reason = agent_loop(history, tools_enabled=tools_enabled)
        if stop_reason == "max_tool_use_turns":
            print("本轮已达到工具调用轮次上限。已有结果已保留，你可以继续下一轮对话。")
        else:
            print_final_response(history)
        print()


if __name__ == "__main__":
    main()

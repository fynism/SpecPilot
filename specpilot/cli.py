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
    readline.parse_and_bind("set bind-tty-special-chars off")
    readline.parse_and_bind("set input-meta on")
    readline.parse_and_bind("set output-meta on")
    readline.parse_and_bind("set convert-meta off")
except ImportError:
    pass

from specpilot.agent import HOOKS, agent_loop


def print_final_response(history: list[dict[str, Any]]) -> None:
    """从最后一条消息中提取并打印模型的文本块。"""
    response_content = history[-1]["content"]
    if isinstance(response_content, list):
        for block in response_content:
            if getattr(block, "type", None) == "text":
                print(block.text)


def main() -> None:
    """启动交互会话并在多次用户输入之间保留消息历史。"""
    print("MyAgent: 一个基于Anthropic Claude的笔记整理Agent")
    print("MyAgent: A note-organizing agent powered by Anthropic Claude\n")
    print("输入一个问题，按Enter发送。输入q退出。")
    print("Enter a question, press Enter to send. Type q to quit.\n")

    # history 是当前 Demo 的会话状态；未来会由持久化 Session 对象替代。
    history: list[dict[str, Any]] = []
    while True:
        try:
            query = input("\033[36mMyAgent >> \033[0m")
        except (EOFError, KeyboardInterrupt):
            break

        if query.strip().lower() in ("q", "exit", ""):
            break

        # 用户输入先经过 Hook，轮次限制或未来的上下文注入可以在调用模型前介入。
        hook_result = HOOKS.trigger("UserPromptSubmit", history, query)
        if hook_result == "stop":
            break

        history.append({"role": "user", "content": query})
        agent_loop(history)
        print_final_response(history)
        print()


if __name__ == "__main__":
    main()

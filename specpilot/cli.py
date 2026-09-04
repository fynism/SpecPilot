"""Interactive command-line interface for the Agent demo."""

from typing import Any

try:
    import readline

    readline.parse_and_bind("set bind-tty-special-chars off")
    readline.parse_and_bind("set input-meta on")
    readline.parse_and_bind("set output-meta on")
    readline.parse_and_bind("set convert-meta off")
except ImportError:
    pass

from specpilot.agent import HOOKS, agent_loop


def print_final_response(history: list[dict[str, Any]]) -> None:
    """Print text blocks from the last assistant response."""
    response_content = history[-1]["content"]
    if isinstance(response_content, list):
        for block in response_content:
            if getattr(block, "type", None) == "text":
                print(block.text)


def main() -> None:
    """Run the interactive CLI session."""
    print("MyAgent: 一个基于Anthropic Claude的笔记整理Agent")
    print("MyAgent: A note-organizing agent powered by Anthropic Claude\n")
    print("输入一个问题，按Enter发送。输入q退出。")
    print("Enter a question, press Enter to send. Type q to quit.\n")

    history: list[dict[str, Any]] = []
    while True:
        try:
            query = input("\033[36mMyAgent >> \033[0m")
        except (EOFError, KeyboardInterrupt):
            break

        if query.strip().lower() in ("q", "exit", ""):
            break

        hook_result = HOOKS.trigger("UserPromptSubmit", history, query)
        if hook_result == "stop":
            break

        history.append({"role": "user", "content": query})
        agent_loop(history)
        print_final_response(history)
        print()


if __name__ == "__main__":
    main()


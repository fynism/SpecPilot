"""Hook registration plus the default Agent lifecycle hooks."""

from collections.abc import Callable
from typing import Any

from specpilot.config import MAX_TURNS, NOTES_DIR
from specpilot.models import ToolCall
from specpilot.policy import ask_user, check_deny_list, check_rules


Hook = Callable[..., Any]


class HookRegistry:
    """Register and dispatch callbacks for Agent lifecycle events."""

    def __init__(self) -> None:
        self._hooks: dict[str, list[Hook]] = {
            "UserPromptSubmit": [],
            "PreToolUse": [],
            "PostToolUse": [],
            "Stop": [],
        }

    def register(self, event: str, callback: Hook) -> None:
        self._hooks[event].append(callback)

    def trigger(self, event: str, *args: Any) -> Any:
        for callback in self._hooks[event]:
            result = callback(*args)
            if result is not None:
                return result
        return None


def context_inject_hook(messages: list[dict[str, Any]], query: str) -> None:
    """Report the current note workspace before each user prompt."""
    print(f"\033[90m[HOOK] UserPromptSubmit: working in {NOTES_DIR}\033[0m")


def max_turns_counter_hook(
    messages: list[dict[str, Any]], query: str
) -> str | None:
    """Stop the session after the configured number of user-role messages."""
    turns = sum(1 for message in messages if message["role"] == "user")
    if turns >= MAX_TURNS:
        print(f"\033[31m> 达到最大对话轮数 {turns}/{MAX_TURNS}, 正在停止...\033[0m")
        return "stop"
    return None


def log_hook(block: ToolCall) -> None:
    """Log a tool call before execution."""
    print(f"[HOOK] {block.name}(...)")


def permission_hook(block: ToolCall) -> str | None:
    """Block forbidden calls and request approval for risky calls."""
    if block.name == "pwsh":
        reason = check_deny_list(block.input.get("command", ""))
        if reason:
            print(f"\n\033[31m[blocked] {reason}\033[0m")
            return reason

    reason = check_rules(block.name, block.input)
    if reason and ask_user(block.name, block.input, reason) == "deny":
        return f"Permission denied: {reason}"
    return None


def large_output_hook(block: ToolCall, output: str) -> None:
    """Warn when a tool returns an unusually large result."""
    if len(str(output)) > 100000:
        print(f"[HOOK] ⚠ Large output from {block.name}")


def summary_hook(messages: list[dict[str, Any]]) -> None:
    """Print a tool-use summary when an Agent turn stops."""
    tool_count = sum(
        1
        for message in messages
        for block in (
            message.get("content")
            if isinstance(message.get("content"), list)
            else []
        )
        if isinstance(block, dict) and block.get("type") == "tool_result"
    )
    print(f"\033[90m[HOOK] Stop: session used {tool_count} tool calls\033[0m")


def build_default_hooks() -> HookRegistry:
    """Create the hook registry used by the CLI Agent."""
    hooks = HookRegistry()
    hooks.register("UserPromptSubmit", context_inject_hook)
    hooks.register("UserPromptSubmit", max_turns_counter_hook)
    hooks.register("PreToolUse", permission_hook)
    hooks.register("PreToolUse", log_hook)
    hooks.register("PostToolUse", large_output_hook)
    hooks.register("Stop", summary_hook)
    return hooks


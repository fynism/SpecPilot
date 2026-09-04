"""The core model/tool Agent loop."""

from typing import Any

from anthropic import Anthropic

from specpilot.config import API_KEY, BASE_URL, MODEL
from specpilot.hooks import build_default_hooks
from specpilot.tools import ToolExecutor, build_default_registry


SYSTEM = """You are a note-organizing agent.

For listing, searching, or reading notes, you MUST use list_notes,
search_notes, or read_notes.

Use pwsh only when the user explicitly requests PowerShell functionality
and no specialized tool can complete the task.

Do not claim to have read a note unless a tool returned it.
"""

client_options = {"api_key": API_KEY}
if BASE_URL:
    client_options["base_url"] = BASE_URL

CLIENT = Anthropic(**client_options)
HOOKS = build_default_hooks()
TOOL_REGISTRY = build_default_registry()
TOOL_EXECUTOR = ToolExecutor(TOOL_REGISTRY, HOOKS.trigger)


def agent_loop(messages: list[dict[str, Any]]) -> None:
    """Call the model and execute requested tools until the model stops."""
    while True:
        response = CLIENT.messages.create(
            model=MODEL,
            system=SYSTEM,
            messages=messages,
            tools=TOOL_REGISTRY.anthropic_tools(),
            max_tokens=8000,
        )

        messages.append({"role": "assistant", "content": response.content})
        tool_calls = [
            block for block in response.content if block.type == "tool_use"
        ]
        if not tool_calls:
            force = HOOKS.trigger("Stop", messages)
            if force:
                messages.append({"role": "user", "content": force})
                continue
            return

        results = []
        for block in tool_calls:
            print(f"\033[33m> {block.name}({block.input})\033[0m")
            output = TOOL_EXECUTOR.execute(block.name, block.input)
            print(
                f"\033[34m {output[:200]}\n"
                f"{'...' if len(output) > 200 else ''}\n\033[0m"
            )
            results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                }
            )

        messages.append({"role": "user", "content": results})


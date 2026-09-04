"""Tool registry, execution pipeline, and built-in tool implementations."""

import os
import subprocess
from collections.abc import Callable
from typing import Any

from pydantic import ValidationError

from specpilot.config import NOTES_DIR
from specpilot.models import (
    EmptyInput,
    PwshInput,
    ReadNotesInput,
    RegisteredTool,
    SearchNotesInput,
    ToolCall,
    ToolSpec,
)


class ToolRegistry:
    """Single source of truth for available tool specifications and handlers."""

    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}

    def register(self, spec: ToolSpec, handler: Callable[[Any], str]) -> None:
        if spec.name in self._tools:
            raise ValueError(f"Tool {spec.name!r} is already registered")
        self._tools[spec.name] = RegisteredTool(spec=spec, handler=handler)

    def get(self, name: str) -> RegisteredTool:
        try:
            return self._tools[name]
        except KeyError as exc:
            raise KeyError(f"Unknown tool {name!r}") from exc

    def anthropic_tools(self) -> list[dict[str, Any]]:
        return [tool.spec.to_anthropic() for tool in self._tools.values()]


class ToolExecutor:
    """Validate and execute registered tools through the shared hook pipeline."""

    def __init__(self, registry: ToolRegistry, hook_dispatcher: Callable[..., Any]) -> None:
        self._registry = registry
        self._trigger_hooks = hook_dispatcher

    def execute(self, name: str, tool_input: dict[str, Any]) -> str:
        try:
            tool = self._registry.get(name)
        except KeyError as exc:
            return f"Error: {exc.args[0]}"

        try:
            validated_input = tool.spec.input_model.model_validate(tool_input)
        except ValidationError as exc:
            details = "; ".join(
                f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
                for error in exc.errors(include_url=False)
            )
            return f"Error: invalid input for tool {name!r}: {details}"

        call = ToolCall(name=name, input=validated_input.model_dump())
        blocked = self._trigger_hooks("PreToolUse", call)
        if blocked is not None:
            return str(blocked)

        try:
            output = str(tool.handler(validated_input))
        except Exception as exc:
            output = f"Error: tool {name!r} failed: {type(exc).__name__}: {exc}"

        self._trigger_hooks("PostToolUse", call, output)
        return output


def list_notes(_: EmptyInput) -> str:
    """Return note paths relative to NOTES_DIR, without reading their contents."""
    if not NOTES_DIR.is_dir():
        return f"No notes directory exists yet: {NOTES_DIR}"
    notes = sorted(
        path.relative_to(NOTES_DIR).as_posix()
        for path in NOTES_DIR.rglob("*.md")
        if path.is_file()
    )
    return "\n".join(notes) if notes else "(no Markdown notes found)"


def search_notes(tool_input: SearchNotesInput) -> str:
    """Search for Markdown notes containing a specific query."""
    if not NOTES_DIR.is_dir():
        return f"No notes directory exists yet: {NOTES_DIR}"
    notes = sorted(
        path.relative_to(NOTES_DIR).as_posix()
        for path in NOTES_DIR.rglob("*.md")
        if path.is_file()
        and tool_input.query.lower() in path.read_text(encoding="utf-8").lower()
    )
    return "\n".join(notes) if notes else "(no Markdown notes found)"


def read_notes(tool_input: ReadNotesInput) -> str:
    """Read the contents of a specific Markdown note."""
    note_path = NOTES_DIR / tool_input.path
    if not note_path.is_file():
        return f"Note not found: {tool_input.path}"
    return note_path.read_text(encoding="utf-8")


def run_pwsh(tool_input: PwshInput) -> str:
    """Run a model-provided PowerShell command in the workspace."""
    try:
        result = subprocess.run(
            ["pwsh", "-NoProfile", "-Command", tool_input.command],
            cwd=os.getcwd(), capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
    except FileNotFoundError:
        return "Error: pwsh was not found on PATH"

    output = (result.stdout + result.stderr).strip()
    if not output:
        output = "(no output)"
    return f"Exit code: {result.returncode}\n{output}"


def build_default_registry() -> ToolRegistry:
    """Register the tools provided by the original Agent demo."""
    registry = ToolRegistry()
    registry.register(
        ToolSpec(name="list_notes", description="List every Markdown note available in the notes directory.", input_model=EmptyInput),
        list_notes,
    )
    registry.register(
        ToolSpec(name="search_notes", description="Search for Markdown notes containing a specific query.", input_model=SearchNotesInput),
        search_notes,
    )
    registry.register(
        ToolSpec(name="read_notes", description="Read a Markdown note by its path relative to the notes directory.", input_model=ReadNotesInput),
        read_notes,
    )
    registry.register(
        ToolSpec(name="pwsh", description="Run a PowerShell command in the workspace and return its output.", input_model=PwshInput),
        run_pwsh,
    )
    return registry


"""实现工具注册、工具执行管线和当前内置工具。

当前职责：
    维护模型可用工具的单一注册表；在执行前校验模型参数并触发 Hook；提供原 Demo 的
    笔记读取和 PowerShell 工具。Agent Loop 只依赖注册表与执行器，不了解工具细节。

后续扩展：
    可把内置工具移动到 ``tools/`` 子包，并加入仓库调查、Spec 操作和 MCP 适配器。
    Registry 也可支持按需加载 Skill 提供的工具，但所有工具仍必须经过同一执行管线。
"""

import os
import subprocess
from collections.abc import Callable
from typing import Any

from pydantic import ValidationError

from specpilot.clarification import ClarificationPresenter, ClarificationService
from specpilot.config import NOTES_DIR
from specpilot.models import (
    EmptyInput,
    PwshInput,
    ReadNotesInput,
    RegisteredTool,
    RequestClarificationInput,
    SearchNotesInput,
    ToolCall,
    ToolSpec,
)


class ToolRegistry:
    """工具声明和处理函数的单一注册中心。"""

    def __init__(self) -> None:
        """创建相互隔离的空工具注册表。"""

        self._tools: dict[str, RegisteredTool] = {}

    def register(self, spec: ToolSpec, handler: Callable[[Any], str]) -> None:
        """注册一个工具；拒绝重名以避免处理函数被静默覆盖。"""
        if spec.name in self._tools:
            raise ValueError(f"Tool {spec.name!r} is already registered")
        self._tools[spec.name] = RegisteredTool(spec=spec, handler=handler)

    def get(self, name: str) -> RegisteredTool:
        """按名称获取工具，并把内部 KeyError 转成更清晰的未知工具错误。"""
        try:
            return self._tools[name]
        except KeyError as exc:
            raise KeyError(f"Unknown tool {name!r}") from exc

    def anthropic_tools(self) -> list[dict[str, Any]]:
        """生成发送给 Anthropic API 的完整工具声明列表。"""
        return [tool.spec.to_anthropic() for tool in self._tools.values()]


class ToolExecutor:
    """让每次工具调用统一经过查找、校验、Hook 和异常处理。"""

    def __init__(self, registry: ToolRegistry, hook_dispatcher: Callable[..., Any]) -> None:
        """注入工具注册表和 Hook 分发器，建立统一执行管线。"""

        # 通过注入 Hook 分发函数保持执行器独立，测试时可以替换为空实现或记录器。
        self._registry = registry
        self._trigger_hooks = hook_dispatcher

    def execute(self, name: str, tool_input: dict[str, Any]) -> str:
        """执行一次模型请求的工具调用，并始终向模型返回字符串结果。"""

        # 先解析注册信息，再校验输入，保证非法参数不会进入工具处理函数。
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

        # Hook 接收规范化后的参数，避免每个 Hook 重复理解原始模型输出。
        call = ToolCall(name=name, input=validated_input.model_dump())
        blocked = self._trigger_hooks("PreToolUse", call)
        if blocked is not None:
            return str(blocked)

        # 工具异常被转换为可反馈给模型的结果，使 Agent 有机会修正调用或解释失败。
        try:
            output = str(tool.handler(validated_input))
        except Exception as exc:
            output = f"Error: tool {name!r} failed: {type(exc).__name__}: {exc}"

        self._trigger_hooks("PostToolUse", call, output)
        return output


def list_notes(_: EmptyInput) -> str:
    """列出笔记相对路径，不读取正文，适合低成本探索目录。"""
    if not NOTES_DIR.is_dir():
        return f"No notes directory exists yet: {NOTES_DIR}"
    notes = sorted(
        path.relative_to(NOTES_DIR).as_posix() for path in NOTES_DIR.rglob("*.md") if path.is_file()
    )
    return "\n".join(notes) if notes else "(no Markdown notes found)"


def search_notes(tool_input: SearchNotesInput) -> str:
    """在 Markdown 正文中执行不区分大小写的简单字符串搜索。"""
    if not NOTES_DIR.is_dir():
        return f"No notes directory exists yet: {NOTES_DIR}"
    notes = sorted(
        path.relative_to(NOTES_DIR).as_posix()
        for path in NOTES_DIR.rglob("*.md")
        if path.is_file() and tool_input.query.lower() in path.read_text(encoding="utf-8").lower()
    )
    return "\n".join(notes) if notes else "(no Markdown notes found)"


def read_notes(tool_input: ReadNotesInput) -> str:
    """读取指定笔记；路径边界由 PreToolUse 权限 Hook 检查。"""
    note_path = NOTES_DIR / tool_input.path
    if not note_path.is_file():
        return f"Note not found: {tool_input.path}"
    return note_path.read_text(encoding="utf-8")


def run_pwsh(tool_input: PwshInput) -> str:
    """在当前工作目录执行模型生成的 PowerShell 命令。

    这是通用但高风险的兜底工具，因此所有调用都会先经过 Policy Hook；未来应优先
    增加用途明确、参数受限的专用工具。
    """
    try:
        # 使用参数数组而非拼接启动命令；实际脚本文本作为 pwsh 的单独参数传入。
        result = subprocess.run(
            ["pwsh", "-NoProfile", "-Command", tool_input.command],
            cwd=os.getcwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        return "Error: pwsh was not found on PATH"

    output = (result.stdout + result.stderr).strip()
    if not output:
        output = "(no output)"
    return f"Exit code: {result.returncode}\n{output}"


def build_default_registry(
    clarification_presenter: ClarificationPresenter,
    event_dispatcher: Callable[..., object] | None = None,
) -> ToolRegistry:
    """集中装配原 Demo 的默认工具集合。"""

    # 通过工厂创建实例，测试、Skill 或不同运行模式可拥有彼此隔离的注册表。
    registry = ToolRegistry()
    registry.register(
        ToolSpec(
            name="list_notes",
            description="List every Markdown note available in the notes directory.",
            input_model=EmptyInput,
        ),
        list_notes,
    )
    registry.register(
        ToolSpec(
            name="search_notes",
            description="Search for Markdown notes containing a specific query.",
            input_model=SearchNotesInput,
        ),
        search_notes,
    )
    registry.register(
        ToolSpec(
            name="read_notes",
            description="Read a Markdown note by its path relative to the notes directory.",
            input_model=ReadNotesInput,
        ),
        read_notes,
    )
    registry.register(
        ToolSpec(
            name="pwsh",
            description="Run a PowerShell command in the workspace and return its output.",
            input_model=PwshInput,
        ),
        run_pwsh,
    )
    clarification_service = ClarificationService(
        presenter=clarification_presenter,
        event_dispatcher=event_dispatcher,
    )
    registry.register(
        ToolSpec(
            name="request_clarification",
            description=(
                "针对一个高影响需求问题向用户提供 2 至 5 个选项、一个有依据的推荐项，"
                "并允许用户在需要时输入自定义答案。"
            ),
            input_model=RequestClarificationInput,
        ),
        clarification_service.request,
    )
    return registry

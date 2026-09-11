"""实现工具注册、工具执行管线和当前内置工具。

当前职责：
    维护模型可用工具的单一注册表；在执行前校验模型参数并触发 Hook；装配只读仓库调查
    和需求澄清工具。Agent Loop 只依赖注册表与执行器，不了解工具细节。

后续扩展：
    Registry 可支持按需加载 Skill 或 MCP 提供的工具，但所有工具仍必须经过同一执行
    管线；组合规模增长后可把默认工具装配独立为组合根，而不改变执行接口。
"""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from specpilot.spec.export import SpecExporter
from specpilot.spec.tools import ApplySpecPatchInput, SpecToolService
from specpilot.tools.clarification import ClarificationPresenter, ClarificationService
from specpilot.tools.models import (
    EmptyInput,
    RegisteredTool,
    RequestClarificationInput,
    ToolCall,
    ToolSpec,
)
from specpilot.tools.repository import (
    ListRepositoryFilesInput,
    ReadRepositoryFileInput,
    RepositoryReader,
    SearchRepositoryInput,
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


def build_default_registry(
    clarification_presenter: ClarificationPresenter,
    event_dispatcher: Callable[..., object] | None = None,
    workspace_root: Path | None = None,
    spec_tools: SpecToolService | None = None,
) -> ToolRegistry:
    """集中装配 SpecPilot MVP 默认开放的最小工具集合。"""

    # 通过工厂创建实例，测试、Skill 或不同运行模式可拥有彼此隔离的注册表。
    registry = ToolRegistry()
    resolved_workspace_root = (workspace_root or Path.cwd()).resolve()
    repository = RepositoryReader(resolved_workspace_root)
    registry.register(
        ToolSpec(
            name="list_repository_files",
            description="列出仓库中的文件，用于低成本了解目录结构；不会读取文件正文。",
            input_model=ListRepositoryFilesInput,
        ),
        repository.list_files,
    )
    registry.register(
        ToolSpec(
            name="search_repository",
            description="在仓库的 UTF-8 文本文件中搜索普通字符串，并返回文件、行号和片段。",
            input_model=SearchRepositoryInput,
        ),
        repository.search,
    )
    registry.register(
        ToolSpec(
            name="read_repository_file",
            description="读取仓库内一个 UTF-8 文本文件的指定行范围；不能访问仓库外路径。",
            input_model=ReadRepositoryFileInput,
        ),
        repository.read_file,
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
    spec_service = spec_tools or SpecToolService.create()
    registry.register(
        ToolSpec(
            name="get_spec",
            description="读取当前 Specification 最新版本的完整结构化事实。",
            input_model=EmptyInput,
        ),
        spec_service.get_spec,
    )
    registry.register(
        ToolSpec(
            name="apply_spec_patch",
            description=(
                "通过一组带类型的语义操作原子更新当前 Specification；必须先用 get_spec "
                "取得 expected_version，不能物理删除历史实体。"
            ),
            input_model=ApplySpecPatchInput,
        ),
        spec_service.apply_spec_patch,
    )
    registry.register(
        ToolSpec(
            name="validate_spec",
            description=(
                "确定性检查当前 Specification 的目标、阻塞问题和需求验收覆盖，"
                "返回是否具备进入人工批准阶段的条件。"
            ),
            input_model=EmptyInput,
        ),
        spec_service.validate_spec,
    )
    exporter = SpecExporter(resolved_workspace_root)

    def export_current_spec(_: EmptyInput) -> str:
        """导出与当前工具集合共享的最新 Spec 快照。"""

        return exporter.export(spec_service.current_spec())

    registry.register(
        ToolSpec(
            name="export_spec",
            description=(
                "把当前结构化 Specification 导出到工作区固定目录中的 spec.json 和 SPEC.md。"
            ),
            input_model=EmptyInput,
        ),
        export_current_spec,
    )
    return registry

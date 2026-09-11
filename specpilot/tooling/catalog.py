"""集中装配 SpecPilot 当前默认开放的工具目录。"""

from collections.abc import Callable
from pathlib import Path

from specpilot.capabilities.clarification.models import RequestClarificationInput
from specpilot.capabilities.clarification.tool import ClarificationPresenter, ClarificationService
from specpilot.capabilities.repository.tool import (
    ListRepositoryFilesInput,
    ReadRepositoryFileInput,
    RepositoryReader,
    SearchRepositoryInput,
)
from specpilot.capabilities.spec.export import SpecExporter
from specpilot.capabilities.spec.operations import ApplySpecPatchInput, SpecToolService
from specpilot.tooling.contracts import EmptyInput, ToolSpec
from specpilot.tooling.registry import ToolRegistry


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

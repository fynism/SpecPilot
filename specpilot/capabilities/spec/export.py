"""从结构化 Specification 生成可移植 JSON 和 Markdown 视图。"""

import json
import os
from pathlib import Path
from uuid import uuid4

from specpilot.capabilities.spec.models import Specification


def _entity_suffix(lifecycle: str) -> str:
    """为已停用实体生成醒目标记。"""

    return "（已停用）" if lifecycle == "retired" else ""


def render_spec_markdown(spec: Specification) -> str:
    """确定性地把结构化 Spec 投影为人工阅读视图。"""

    lines = [
        f"# {spec.title}",
        "",
        f"- Spec ID：`{spec.spec_id}`",
        f"- 版本：{spec.version}",
        f"- 状态：`{spec.status}`",
        f"- 本版原因：{spec.change_reason}",
        "",
    ]

    def append_entities(title: str, entities: tuple[object, ...]) -> None:
        """以统一格式追加带 statement 的实体列表。"""

        lines.extend([f"## {title}", ""])
        if not entities:
            lines.extend(["_暂无。_", ""])
            return
        for entity in entities:
            entity_id = getattr(entity, "id")
            statement = getattr(entity, "statement")
            lifecycle = getattr(entity, "lifecycle")
            evidence_ids = getattr(entity, "evidence_ids")
            lines.append(f"- **{entity_id}**{_entity_suffix(lifecycle)}：{statement}")
            if evidence_ids:
                lines.append(f"  - 证据：{', '.join(evidence_ids)}")
        lines.append("")

    append_entities("目标", spec.goals)
    append_entities("范围", spec.scope)
    append_entities("需求", spec.requirements)
    append_entities("决策", spec.decisions)
    append_entities("假设", spec.assumptions)
    append_entities("未决问题", spec.open_questions)

    lines.extend(["## 验收条件", ""])
    if not spec.acceptance_criteria:
        lines.extend(["_暂无。_", ""])
    for criterion in spec.acceptance_criteria:
        lines.append(
            f"### {criterion.id}{_entity_suffix(criterion.lifecycle)} — {criterion.statement}"
        )
        lines.append("")
        lines.append(f"关联需求：{', '.join(criterion.requirement_ids)}")
        lines.append("")
        if criterion.given is not None:
            lines.extend(
                [
                    f"- Given：{criterion.given}",
                    f"- When：{criterion.when}",
                    f"- Then：{criterion.then}",
                    "",
                ]
            )

    lines.extend(["## 证据", ""])
    if not spec.evidence:
        lines.extend(["_暂无。_", ""])
    for evidence in spec.evidence:
        lines.append(f"- **{evidence.id}** `{evidence.kind}`：{evidence.summary}")
        lines.append(f"  - 来源：{evidence.locator}")
    lines.append("")
    return "\n".join(lines)


class SpecExporter:
    """只向工作区固定 artifact 目录原子写入 Spec 视图。"""

    def __init__(self, workspace_root: Path) -> None:
        """绑定解析后的工作区根目录。"""

        self._workspace_root = workspace_root.resolve()
        if not self._workspace_root.is_dir():
            raise ValueError(f"工作区根目录不存在或不是目录：{self._workspace_root}")

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        """先完整写入同目录临时文件，再原子替换目标文件。"""

        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            temporary.write_text(content, encoding="utf-8", newline="\n")
            os.replace(temporary, path)
        finally:
            # replace 成功后临时文件已不存在；失败时尽力清理，不能遗留半写 artifact。
            temporary.unlink(missing_ok=True)

    def export(self, spec: Specification) -> str:
        """写入 spec.json 和 SPEC.md，并返回相对路径及版本。"""

        output_directory = (self._workspace_root / ".specpilot" / "specs" / spec.spec_id).resolve()
        # 固定相对路径仍可能被仓库内已有符号链接劫持，因此写入前必须复验解析结果。
        if not output_directory.is_relative_to(self._workspace_root):
            raise ValueError("Spec 导出目录解析到了工作区之外")
        output_directory.mkdir(parents=True, exist_ok=True)
        json_path = output_directory / "spec.json"
        markdown_path = output_directory / "SPEC.md"

        json_content = json.dumps(
            spec.model_dump(mode="json"),
            ensure_ascii=False,
            indent=2,
        )
        self._atomic_write(json_path, f"{json_content}\n")
        self._atomic_write(markdown_path, render_spec_markdown(spec))

        result = {
            "spec_id": spec.spec_id,
            "version": spec.version,
            "json_path": json_path.relative_to(self._workspace_root).as_posix(),
            "markdown_path": markdown_path.relative_to(self._workspace_root).as_posix(),
        }
        return json.dumps(result, ensure_ascii=False, separators=(",", ":"))

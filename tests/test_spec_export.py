"""Specification JSON 与 Markdown 导出的行为测试。"""

import json
from datetime import UTC, datetime
from pathlib import Path

from specpilot.spec.export import SpecExporter, render_spec_markdown
from specpilot.spec.models import (
    AcceptanceCriterion,
    Goal,
    Requirement,
    Specification,
    create_specification,
)

NOW = datetime(2026, 9, 5, 8, 0, tzinfo=UTC)


def make_spec() -> Specification:
    """创建包含 BDD 验收条件的可导出 Spec。"""

    original = create_specification("数据导出", now=NOW)
    requirement = Requirement(
        id="R-001",
        statement="管理员可以导出",
        acceptance_criterion_ids=("AC-001",),
    )
    criterion = AcceptanceCriterion(
        id="AC-001",
        statement="管理员获得导出文件",
        requirement_ids=("R-001",),
        given="当前用户是管理员",
        when="用户发起导出",
        then="系统返回导出文件",
    )
    payload = original.model_dump()
    payload.update(
        {
            "goals": (Goal(id="G-001", statement="允许管理员导出数据"),),
            "requirements": (requirement,),
            "acceptance_criteria": (criterion,),
        }
    )
    return Specification.model_validate(payload)


def test_markdown_is_projected_from_structured_spec() -> None:
    """Markdown 包含身份、需求和完整 BDD 场景。"""

    markdown = render_spec_markdown(make_spec())

    assert "# 数据导出" in markdown
    assert "**R-001**：管理员可以导出" in markdown
    assert "Given：当前用户是管理员" in markdown
    assert "When：用户发起导出" in markdown
    assert "Then：系统返回导出文件" in markdown


def test_export_writes_fixed_workspace_paths(tmp_path: Path) -> None:
    """导出器只在固定工作区 artifact 目录生成两种视图。"""

    spec = make_spec()
    result = json.loads(SpecExporter(tmp_path).export(spec))

    json_path = tmp_path / result["json_path"]
    markdown_path = tmp_path / result["markdown_path"]
    assert json_path == tmp_path / ".specpilot" / "specs" / spec.spec_id / "spec.json"
    assert markdown_path.name == "SPEC.md"
    assert json.loads(json_path.read_text(encoding="utf-8"))["spec_id"] == spec.spec_id
    assert markdown_path.read_text(encoding="utf-8").startswith("# 数据导出\n")


def test_export_replaces_existing_view_with_latest_version(tmp_path: Path) -> None:
    """重复导出使用原子替换更新视图，不在旧文件后追加内容。"""

    spec = make_spec()
    exporter = SpecExporter(tmp_path)
    first = json.loads(exporter.export(spec))
    updated = spec.model_copy(update={"version": 2, "change_reason": "补充验收条件"})

    exporter.export(updated)

    json_path = tmp_path / first["json_path"]
    content = json.loads(json_path.read_text(encoding="utf-8"))
    assert content["version"] == 2
    assert content["change_reason"] == "补充验收条件"

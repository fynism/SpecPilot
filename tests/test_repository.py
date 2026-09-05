"""只读仓库调查能力的行为测试。"""

import json
from pathlib import Path

import pytest

from specpilot.clarification import ClarificationRequest
from specpilot.models import ClarificationAnswer
from specpilot.repository import (
    ListRepositoryFilesInput,
    ReadRepositoryFileInput,
    RepositoryReader,
    SearchRepositoryInput,
)
from specpilot.tools import build_default_registry


class NoopPresenter:
    """仓库工具测试中不会被调用的澄清界面替身。"""

    def ask(self, request: ClarificationRequest) -> ClarificationAnswer:
        """如果测试意外触发用户交互，则立即暴露错误。"""

        raise AssertionError(f"不应发起澄清：{request.request_id}")


def test_default_registry_only_exposes_read_only_repository_and_clarification_tools(
    tmp_path: Path,
) -> None:
    """Note 和 Shell 能力不会残留在模型可见的默认工具面。"""

    registry = build_default_registry(NoopPresenter(), workspace_root=tmp_path)

    names = {tool["name"] for tool in registry.anthropic_tools()}

    assert names == {
        "list_repository_files",
        "search_repository",
        "read_repository_file",
        "request_clarification",
        "get_spec",
        "apply_spec_patch",
    }


def test_list_files_ignores_internal_directories(tmp_path: Path) -> None:
    """目录列表不会把版本库、虚拟环境或缓存内容交给模型。"""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('ok')\n", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("secret-ish metadata", encoding="utf-8")
    reader = RepositoryReader(tmp_path)

    result = json.loads(reader.list_files(ListRepositoryFilesInput()))

    assert result == {"files": ["src/main.py"], "truncated": False}


def test_search_returns_file_line_and_text(tmp_path: Path) -> None:
    """普通字符串搜索返回可追溯且大小受限的匹配信息。"""

    (tmp_path / "app.py").write_text("first\nExportService enabled\n", encoding="utf-8")
    reader = RepositoryReader(tmp_path)

    result = json.loads(
        reader.search(SearchRepositoryInput(query="exportservice", file_pattern="*.py"))
    )

    assert result == {
        "matches": [{"path": "app.py", "line": 2, "text": "ExportService enabled"}],
        "truncated": False,
    }


def test_read_file_supports_line_ranges_and_truncation(tmp_path: Path) -> None:
    """读取工具只返回请求范围，并明确标记字符上限导致的截断。"""

    (tmp_path / "rules.txt").write_text("one\ntwo\n" + "x" * 150, encoding="utf-8")
    reader = RepositoryReader(tmp_path)

    result = json.loads(
        reader.read_file(ReadRepositoryFileInput(path="rules.txt", start_line=2, max_chars=100))
    )

    assert result["content"].startswith("two\n")
    assert len(result["content"]) == 100
    assert result["truncated"] is True


def test_read_file_rejects_paths_outside_repository(tmp_path: Path) -> None:
    """目录穿越不能读取仓库根目录之外的文件。"""

    repository = tmp_path / "repository"
    repository.mkdir()
    (tmp_path / "outside.txt").write_text("private", encoding="utf-8")
    reader = RepositoryReader(repository)

    with pytest.raises(ValueError, match="仓库根目录之外"):
        reader.read_file(ReadRepositoryFileInput(path="../outside.txt"))

"""提供受工作区边界约束的只读仓库调查工具。"""

import fnmatch
import json
import os
from collections.abc import Iterator
from pathlib import Path

from pydantic import Field, model_validator

from specpilot.models import ToolInput

IGNORED_DIRECTORY_NAMES = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "build",
        "dist",
        "node_modules",
    }
)
MAX_SEARCH_FILE_BYTES = 1_000_000


class ListRepositoryFilesInput(ToolInput):
    """列出仓库文件所需的受限参数。"""

    path: str = Field(default=".", min_length=1, description="相对于仓库根目录的目录。")
    max_depth: int = Field(default=4, ge=0, le=10, description="向下遍历的最大目录深度。")
    max_results: int = Field(default=200, ge=1, le=500, description="最多返回的文件数量。")


class SearchRepositoryInput(ToolInput):
    """在仓库文本文件中搜索普通字符串所需的参数。"""

    query: str = Field(min_length=1, max_length=500, description="要查找的普通文本。")
    path: str = Field(default=".", min_length=1, description="相对于仓库根目录的搜索目录。")
    file_pattern: str = Field(default="*", min_length=1, description="文件名 glob，例如 *.py。")
    max_results: int = Field(default=50, ge=1, le=200, description="最多返回的匹配数量。")


class ReadRepositoryFileInput(ToolInput):
    """读取仓库文本文件及可选行范围所需的参数。"""

    path: str = Field(min_length=1, description="相对于仓库根目录的文件路径。")
    start_line: int = Field(default=1, ge=1, description="从这一行开始读取，行号从 1 开始。")
    end_line: int | None = Field(default=None, ge=1, description="读取到这一行；省略表示文件末尾。")
    max_chars: int = Field(default=50_000, ge=100, le=100_000, description="最多返回的字符数。")

    @model_validator(mode="after")
    def validate_line_range(self) -> "ReadRepositoryFileInput":
        """拒绝结束行早于开始行的无效范围。"""

        if self.end_line is not None and self.end_line < self.start_line:
            raise ValueError("end_line 不能小于 start_line")
        return self


class RepositoryReader:
    """在固定仓库根目录内实现列举、搜索和读取能力。"""

    def __init__(self, root: Path) -> None:
        """保存解析后的仓库根目录，后续所有路径都以它为安全边界。"""

        self._root = root.resolve()
        if not self._root.is_dir():
            raise ValueError(f"仓库根目录不存在或不是目录：{self._root}")

    def _resolve(self, relative_path: str) -> Path:
        """解析相对路径，并拒绝绝对路径、目录穿越和越界符号链接。"""

        supplied = Path(relative_path)
        if supplied.is_absolute():
            raise ValueError("仓库工具只接受相对于仓库根目录的路径")
        resolved = (self._root / supplied).resolve()
        # resolve 会跟随符号链接，因此该检查同时阻止指向工作区外部的链接。
        if not resolved.is_relative_to(self._root):
            raise ValueError("拒绝访问仓库根目录之外的路径")
        return resolved

    def _iter_files(self, directory: Path) -> Iterator[Path]:
        """遍历文本候选文件，并在进入目录前剪除缓存和依赖目录。"""

        for current_root, directory_names, file_names in os.walk(directory, followlinks=False):
            directory_names[:] = sorted(
                name for name in directory_names if name not in IGNORED_DIRECTORY_NAMES
            )
            current_path = Path(current_root)
            for file_name in sorted(file_names):
                candidate = (current_path / file_name).resolve()
                # 文件本身也可能是越界符号链接，不能只依赖 os.walk 的 followlinks=False。
                if candidate.is_relative_to(self._root) and candidate.is_file():
                    yield candidate

    def list_files(self, tool_input: ListRepositoryFilesInput) -> str:
        """按稳定顺序列出仓库文件，并显式报告结果是否被截断。"""

        directory = self._resolve(tool_input.path)
        if not directory.is_dir():
            raise ValueError(f"目标不是可读取目录：{tool_input.path}")

        files: list[str] = []
        truncated = False
        for candidate in self._iter_files(directory):
            relative_to_start = candidate.relative_to(directory)
            if len(relative_to_start.parts) - 1 > tool_input.max_depth:
                continue
            if len(files) == tool_input.max_results:
                truncated = True
                break
            files.append(candidate.relative_to(self._root).as_posix())

        return json.dumps({"files": files, "truncated": truncated}, ensure_ascii=False)

    def search(self, tool_input: SearchRepositoryInput) -> str:
        """在 UTF-8 文本文件中执行不区分大小写的普通字符串搜索。"""

        directory = self._resolve(tool_input.path)
        if not directory.is_dir():
            raise ValueError(f"目标不是可搜索目录：{tool_input.path}")

        matches: list[dict[str, object]] = []
        truncated = False
        normalized_query = tool_input.query.casefold()
        for candidate in self._iter_files(directory):
            relative_path = candidate.relative_to(self._root).as_posix()
            if not fnmatch.fnmatch(candidate.name, tool_input.file_pattern):
                continue
            if candidate.stat().st_size > MAX_SEARCH_FILE_BYTES:
                continue
            try:
                with candidate.open("r", encoding="utf-8") as source:
                    for line_number, line in enumerate(source, start=1):
                        if normalized_query not in line.casefold():
                            continue
                        if len(matches) == tool_input.max_results:
                            truncated = True
                            break
                        matches.append(
                            {
                                "path": relative_path,
                                "line": line_number,
                                "text": line.rstrip("\r\n")[:500],
                            }
                        )
            except (OSError, UnicodeDecodeError):
                # 二进制、非 UTF-8 或读取失败的文件不应让一次仓库调查整体失败。
                continue
            if truncated:
                break

        return json.dumps({"matches": matches, "truncated": truncated}, ensure_ascii=False)

    def read_file(self, tool_input: ReadRepositoryFileInput) -> str:
        """读取一个 UTF-8 文件的指定行范围，并限制返回上下文大小。"""

        file_path = self._resolve(tool_input.path)
        if not file_path.is_file():
            raise ValueError(f"目标不是可读取文件：{tool_input.path}")

        content_parts: list[str] = []
        returned_chars = 0
        last_line = tool_input.start_line - 1
        truncated = False
        try:
            with file_path.open("r", encoding="utf-8") as source:
                for line_number, line in enumerate(source, start=1):
                    if line_number < tool_input.start_line:
                        continue
                    if tool_input.end_line is not None and line_number > tool_input.end_line:
                        break
                    remaining = tool_input.max_chars - returned_chars
                    if len(line) > remaining:
                        content_parts.append(line[:remaining])
                        last_line = line_number
                        truncated = True
                        break
                    content_parts.append(line)
                    returned_chars += len(line)
                    last_line = line_number
        except UnicodeDecodeError as exc:
            raise ValueError("只允许读取 UTF-8 文本文件") from exc

        result = {
            "path": file_path.relative_to(self._root).as_posix(),
            "start_line": tool_input.start_line,
            "end_line": last_line,
            "content": "".join(content_parts),
            "truncated": truncated,
        }
        return json.dumps(result, ensure_ascii=False)

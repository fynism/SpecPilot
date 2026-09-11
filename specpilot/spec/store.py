"""定义 Spec Store 契约和适用于单进程 MVP 的内存实现。"""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from specpilot.spec.models import Specification


class SpecNotFoundError(LookupError):
    """表示请求的 Spec 或历史版本不存在。"""


class SpecConflictError(RuntimeError):
    """表示创建重复 Spec 或保存时发生乐观并发冲突。"""


class SpecStore(Protocol):
    """保存和读取不可变 Spec 版本的最小接口。"""

    def create(self, spec: Specification) -> Specification:
        """保存第一个版本，并拒绝重复 ID。"""

    def get(self, spec_id: str, version: int | None = None) -> Specification:
        """读取最新版本或指定历史版本。"""

    def save(self, spec: Specification, expected_version: int) -> Specification:
        """校验预期版本后追加一个新版本。"""


class InMemorySpecStore:
    """在内存中保留完整版本历史，适合当前单进程 CLI 和单元测试。"""

    def __init__(self, clock: Callable[[], datetime] | None = None) -> None:
        """注入时钟以保证版本时间相关测试可重复。"""

        self._clock = clock or (lambda: datetime.now(UTC))
        self._history: dict[str, list[Specification]] = {}

    def create(self, spec: Specification) -> Specification:
        """保存第一个版本，并返回与内部状态隔离的副本。"""

        if spec.spec_id in self._history:
            raise SpecConflictError(f"Spec 已存在：{spec.spec_id}")
        if spec.version != 1:
            raise SpecConflictError("新建 Spec 的版本必须为 1")
        stored = spec.model_copy(deep=True)
        self._history[spec.spec_id] = [stored]
        return stored.model_copy(deep=True)

    def get(self, spec_id: str, version: int | None = None) -> Specification:
        """读取最新版本或指定历史版本，不暴露内部可变容器。"""

        try:
            history = self._history[spec_id]
        except KeyError as exc:
            raise SpecNotFoundError(f"Spec 不存在：{spec_id}") from exc

        if version is None:
            return history[-1].model_copy(deep=True)
        for candidate in history:
            if candidate.version == version:
                return candidate.model_copy(deep=True)
        raise SpecNotFoundError(f"Spec {spec_id} 不存在版本 {version}")

    def save(self, spec: Specification, expected_version: int) -> Specification:
        """通过乐观锁追加版本，避免后写入静默覆盖先写入。"""

        current = self.get(spec.spec_id)
        if current.version != expected_version:
            raise SpecConflictError(
                f"Spec 版本冲突：期望 {expected_version}，当前 {current.version}"
            )
        # 调用方只能修改当前快照；版本、创建时间和更新时间由 Store 统一控制。
        if spec.version != expected_version:
            raise SpecConflictError("待保存 Spec 的版本必须与 expected_version 一致")
        if spec.created_at != current.created_at:
            raise SpecConflictError("不能修改 Spec 的创建时间")

        stored = spec.model_copy(
            update={"version": expected_version + 1, "updated_at": self._clock()},
            deep=True,
        )
        self._history[spec.spec_id].append(stored)
        return stored.model_copy(deep=True)

    def versions(self, spec_id: str) -> tuple[int, ...]:
        """返回已有版本号，供测试和以后展示历史使用。"""

        if spec_id not in self._history:
            raise SpecNotFoundError(f"Spec 不存在：{spec_id}")
        return tuple(spec.version for spec in self._history[spec_id])

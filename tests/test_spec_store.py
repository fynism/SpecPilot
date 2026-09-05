"""内存 Spec Store 的版本和并发行为测试。"""

from datetime import UTC, datetime

import pytest

from specpilot.spec import create_specification
from specpilot.spec_store import InMemorySpecStore, SpecConflictError, SpecNotFoundError

CREATED_AT = datetime(2026, 9, 5, 8, 0, tzinfo=UTC)
UPDATED_AT = datetime(2026, 9, 5, 9, 0, tzinfo=UTC)


def test_store_creates_and_reads_latest_spec() -> None:
    """Store 保存后可以按 ID 读取同一份结构化事实。"""

    store = InMemorySpecStore()
    created = store.create(create_specification("数据导出", now=CREATED_AT))

    loaded = store.get(created.spec_id)

    assert loaded == created
    assert loaded is not created


def test_save_increments_version_and_keeps_history() -> None:
    """每次成功保存都追加版本，旧版本仍然可读取。"""

    store = InMemorySpecStore(clock=lambda: UPDATED_AT)
    original = store.create(create_specification("数据导出", now=CREATED_AT))
    changed = original.model_copy(update={"status": "clarifying"})

    saved = store.save(changed, expected_version=1)

    assert saved.version == 2
    assert saved.status == "clarifying"
    assert saved.updated_at == UPDATED_AT
    assert store.get(original.spec_id, version=1).status == "draft"
    assert store.versions(original.spec_id) == (1, 2)


def test_save_rejects_stale_expected_version() -> None:
    """过期调用方不能覆盖已经更新的 Spec。"""

    store = InMemorySpecStore(clock=lambda: UPDATED_AT)
    original = store.create(create_specification("数据导出", now=CREATED_AT))
    store.save(original.model_copy(update={"status": "clarifying"}), expected_version=1)

    with pytest.raises(SpecConflictError, match="版本冲突"):
        store.save(original, expected_version=1)


def test_store_rejects_duplicate_spec_id() -> None:
    """重复创建不能静默覆盖已有版本历史。"""

    store = InMemorySpecStore()
    spec = create_specification("数据导出", now=CREATED_AT)
    store.create(spec)

    with pytest.raises(SpecConflictError, match="已存在"):
        store.create(spec)


def test_missing_spec_is_explicit() -> None:
    """读取不存在的 Spec 时返回明确领域异常。"""

    with pytest.raises(SpecNotFoundError, match="不存在"):
        InMemorySpecStore().get("SP-000000000000")

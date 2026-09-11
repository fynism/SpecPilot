"""Specification 读写工具的原子行为测试。"""

import json
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from specpilot.capabilities.spec.operations import ApplySpecPatchInput, SpecToolService
from specpilot.capabilities.spec.store import InMemorySpecStore
from specpilot.tooling.contracts import EmptyInput

NOW = datetime(2026, 9, 5, 8, 0, tzinfo=UTC)
LATER = datetime(2026, 9, 5, 9, 0, tzinfo=UTC)


def make_service() -> tuple[SpecToolService, InMemorySpecStore]:
    """创建使用固定时间的单会话 Spec 工具服务。"""

    store = InMemorySpecStore(clock=lambda: LATER)
    return SpecToolService.create(store=store, clock=lambda: NOW), store


def test_get_spec_returns_current_structured_fact_source() -> None:
    """读取工具返回当前 Spec ID、版本和初始空集合。"""

    service, _ = make_service()

    result = json.loads(service.get_spec(EmptyInput()))

    assert result["spec_id"] == service.spec_id
    assert result["version"] == 1
    assert result["requirements"] == []


def test_patch_records_evidence_decision_and_requirement_atomically() -> None:
    """同一 Patch 可以建立来源、决定和需求之间的引用。"""

    service, store = make_service()
    patch = ApplySpecPatchInput.model_validate(
        {
            "expected_version": 1,
            "change_reason": "记录用户对导出权限的选择",
            "operations": [
                {
                    "op": "record_evidence",
                    "id": "E-001",
                    "kind": "clarification",
                    "summary": "用户选择仅管理员导出",
                    "locator": "Q-abc123",
                },
                {
                    "op": "record_decision",
                    "id": "D-001",
                    "statement": "仅管理员可以导出",
                    "evidence_ids": ["E-001"],
                    "rationale": "用户明确选择",
                    "made_by": "user",
                },
                {
                    "op": "put_requirement",
                    "id": "R-001",
                    "statement": "系统只允许管理员发起导出",
                    "evidence_ids": ["E-001"],
                },
            ],
        }
    )

    result = json.loads(service.apply_spec_patch(patch))

    assert result["version"] == 2
    assert result["decisions"][0]["made_by"] == "user"
    assert result["requirements"][0]["evidence_ids"] == ["E-001"]
    assert store.versions(service.spec_id) == (1, 2)


def test_invalid_cross_reference_rolls_back_entire_patch() -> None:
    """任一引用校验失败时，前面的临时操作也不能保存。"""

    service, store = make_service()
    patch = ApplySpecPatchInput.model_validate(
        {
            "expected_version": 1,
            "change_reason": "无效引用",
            "operations": [
                {
                    "op": "put_goal",
                    "id": "G-001",
                    "statement": "支持数据导出",
                },
                {
                    "op": "put_requirement",
                    "id": "R-001",
                    "statement": "仅管理员导出",
                    "evidence_ids": ["E-999"],
                },
            ],
        }
    )

    with pytest.raises(ValidationError, match="不存在的 Evidence"):
        service.apply_spec_patch(patch)

    assert store.versions(service.spec_id) == (1,)
    assert store.get(service.spec_id).goals == ()


def test_patch_allows_forward_reference_within_the_same_atomic_batch() -> None:
    """Requirement 可以先引用同一 Patch 后续创建的验收条件。"""

    service, _ = make_service()
    patch = ApplySpecPatchInput.model_validate(
        {
            "expected_version": 1,
            "change_reason": "同时记录需求和验收条件",
            "operations": [
                {
                    "op": "put_requirement",
                    "id": "R-001",
                    "statement": "管理员可以导出",
                    "acceptance_criterion_ids": ["AC-001"],
                },
                {
                    "op": "put_acceptance_criterion",
                    "id": "AC-001",
                    "statement": "管理员发起导出后获得文件",
                    "requirement_ids": ["R-001"],
                },
            ],
        }
    )

    result = json.loads(service.apply_spec_patch(patch))

    assert result["requirements"][0]["acceptance_criterion_ids"] == ["AC-001"]


def test_stale_patch_is_rejected_before_mutation() -> None:
    """模型基于旧版本生成的 Patch 不能覆盖新状态。"""

    service, store = make_service()
    first = ApplySpecPatchInput.model_validate(
        {
            "expected_version": 1,
            "change_reason": "进入澄清",
            "operations": [{"op": "set_spec_metadata", "status": "clarifying"}],
        }
    )
    service.apply_spec_patch(first)

    with pytest.raises(ValueError, match="版本冲突"):
        service.apply_spec_patch(first)

    assert store.versions(service.spec_id) == (1, 2)


def test_repository_evidence_cannot_be_forged_as_a_user_decision() -> None:
    """模型不能把仓库文本冒充为用户亲自确认的决定。"""

    service, store = make_service()
    patch = ApplySpecPatchInput.model_validate(
        {
            "expected_version": 1,
            "change_reason": "伪造用户来源",
            "operations": [
                {
                    "op": "record_evidence",
                    "id": "E-001",
                    "kind": "repository",
                    "summary": "README 中提到了管理员",
                    "locator": "README.md:10",
                },
                {
                    "op": "record_decision",
                    "id": "D-001",
                    "statement": "用户选择仅管理员导出",
                    "evidence_ids": ["E-001"],
                    "rationale": "错误地把仓库内容当成用户选择",
                    "made_by": "user",
                },
            ],
        }
    )

    with pytest.raises(ValidationError, match="必须引用用户陈述或澄清回答"):
        service.apply_spec_patch(patch)

    assert store.versions(service.spec_id) == (1,)


def test_retire_preserves_item_in_new_version_and_history() -> None:
    """停用实体只改变生命周期，不会物理删除事实或历史版本。"""

    service, store = make_service()
    add = ApplySpecPatchInput.model_validate(
        {
            "expected_version": 1,
            "change_reason": "添加范围",
            "operations": [
                {
                    "op": "put_scope_item",
                    "id": "S-001",
                    "statement": "支持 CSV",
                    "disposition": "in_scope",
                }
            ],
        }
    )
    service.apply_spec_patch(add)
    retire = ApplySpecPatchInput.model_validate(
        {
            "expected_version": 2,
            "change_reason": "CSV 不再属于范围",
            "operations": [{"op": "retire_item", "id": "S-001"}],
        }
    )

    result = json.loads(service.apply_spec_patch(retire))

    assert result["scope"][0]["lifecycle"] == "retired"
    assert store.get(service.spec_id, version=2).scope[0].lifecycle == "active"


def test_patch_operation_rejects_unknown_fields() -> None:
    """模型不能借由自由字段绕过每种语义操作的 Schema。"""

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ApplySpecPatchInput.model_validate(
            {
                "expected_version": 1,
                "change_reason": "非法字段",
                "operations": [
                    {
                        "op": "put_goal",
                        "id": "G-001",
                        "statement": "支持导出",
                        "unexpected": "绕过约束",
                    }
                ],
            }
        )

"""环境配置加载和边界校验测试。"""

import pytest

from specpilot import config


def prepare_required_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """设置最小模型配置，并阻止测试读取真实 .env。"""

    monkeypatch.setattr(config, "load_dotenv", lambda **_kwargs: True)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MODEL_ID", "test-model")


def test_settings_load_tool_use_turn_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    """新配置按单次 Agent Loop 的工具轮次读取。"""

    prepare_required_environment(monkeypatch)
    monkeypatch.setenv("MAX_TOOL_USE_TURNS", "24")

    settings = config.load_settings()

    assert settings.max_tool_use_turns == 24


@pytest.mark.parametrize("value", ["0", "-1", "not-an-integer"])
def test_settings_reject_invalid_tool_use_turn_limit(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """非正整数不能成为 Agent Loop 的停止预算。"""

    prepare_required_environment(monkeypatch)
    monkeypatch.setenv("MAX_TOOL_USE_TURNS", value)

    with pytest.raises(RuntimeError, match="MAX_TOOL_USE_TURNS"):
        config.load_settings()

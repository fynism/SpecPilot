"""Anthropic 模型适配器的请求边界测试。"""

from types import SimpleNamespace
from typing import Any

import pytest

from specpilot.integrations.anthropic.model import AnthropicModelClient


def test_empty_tool_set_is_omitted_from_provider_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """总结轮不向供应商发送 tools 字段，形成模型侧硬边界。"""

    client = AnthropicModelClient(api_key="test-key", model="test-model")
    captured: dict[str, Any] = {}

    def capture_request(**request: Any) -> SimpleNamespace:
        """记录适配器构造的请求，不执行真实网络调用。"""

        captured.update(request)
        return SimpleNamespace(content=[])

    monkeypatch.setattr(client._client.messages, "create", capture_request)

    result = client.create_message(messages=[], tools=(), system="只总结", max_tokens=100)

    assert result == ()
    assert "tools" not in captured

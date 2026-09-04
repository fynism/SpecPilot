"""实现 SpecPilot 当前最核心的模型—工具循环。

当前职责：
    创建模型客户端，装配默认 Hook 与工具，并不断把模型请求的工具结果反馈回模型，
    直到模型返回普通文本或 Stop Hook 要求继续。

后续扩展：
    可以加入会话状态、checkpoint、上下文构建、结构化停止原因和 Clarification HITL。
    Agent Loop 应保持框架无关，不直接包含具体 Spec、Skill 或 MCP 的业务判断。
"""

from typing import Any

from anthropic import Anthropic

from specpilot.config import API_KEY, BASE_URL, MODEL
from specpilot.hooks import build_default_hooks
from specpilot.tools import ToolExecutor, build_default_registry


# 系统提示只描述 Agent 的角色与工具使用边界；未来可由基础提示和按需 Skill 组合。
SYSTEM = """You are a note-organizing agent.

For listing, searching, or reading notes, you MUST use list_notes,
search_notes, or read_notes.

Use pwsh only when the user explicitly requests PowerShell functionality
and no specialized tool can complete the task.

Do not claim to have read a note unless a tool returned it.
"""

# 依赖在模块装配阶段创建，保持与原 Demo 相同的启动行为。
client_options = {"api_key": API_KEY}
if BASE_URL:
    client_options["base_url"] = BASE_URL

# 这些是 CLI 默认运行时依赖。未来可用 AgentRuntime 对象封装，便于测试和多会话隔离。
CLIENT = Anthropic(**client_options)
HOOKS = build_default_hooks()
TOOL_REGISTRY = build_default_registry()
TOOL_EXECUTOR = ToolExecutor(TOOL_REGISTRY, HOOKS.trigger)


def agent_loop(messages: list[dict[str, Any]]) -> None:
    """运行一个完整 Agent 回合，直到模型不再请求工具。"""

    while True:
        # 每轮都携带完整消息和当前工具声明，让模型基于最新工具结果决定下一步。
        response = CLIENT.messages.create(
            model=MODEL,
            system=SYSTEM,
            messages=messages,
            tools=TOOL_REGISTRY.anthropic_tools(),
            max_tokens=8000,
        )

        # 先保存模型原始内容，保证后续工具结果能通过 tool_use_id 正确对应。
        messages.append({"role": "assistant", "content": response.content})
        tool_calls = [
            block for block in response.content if block.type == "tool_use"
        ]
        if not tool_calls:
            # Stop Hook 可返回一条新的用户消息强制继续，例如执行收尾检查。
            force = HOOKS.trigger("Stop", messages)
            if force:
                messages.append({"role": "user", "content": force})
                continue
            return

        # 同一模型响应可能包含多个工具调用；统一收集后作为一个 user turn 回传。
        results = []
        for block in tool_calls:
            print(f"\033[33m> {block.name}({block.input})\033[0m")
            output = TOOL_EXECUTOR.execute(block.name, block.input)
            print(
                f"\033[34m {output[:200]}\n"
                f"{'...' if len(output) > 200 else ''}\n\033[0m"
            )
            results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                }
            )

        messages.append({"role": "user", "content": results})

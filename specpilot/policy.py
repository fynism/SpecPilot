"""定义工具执行前的权限规则和人工审批逻辑。

当前职责：
    通过不可绕过的拒绝名单和需要用户确认的权限规则，对工具调用进行风险分级。
    本模块只回答“是否安全、是否需要批准”，不负责真正执行工具。

后续扩展：
    可以演进为独立 Policy Engine，支持工作区边界、工具风险等级、会话级授权、
    审批记录和可配置策略。需求澄清 HITL 应单独建模，不能与安全审批混为一体。
"""

from typing import Any

from specpilot.config import NOTES_DIR


# Gate 1：命中后无论用户是否愿意都拒绝，作为运行时不可绕过的安全底线。
DENY_LIST = [
    "clear-disk", "format-volume", "initialize-disk", "remove-partition",
    "diskpart", "stop-computer", "restart-computer", "shutdown.exe",
    "bcdedit", "vssadmin delete shadows",
]

# Gate 2：命中后并不直接拒绝，而是交由 Gate 3 请求用户明确批准。
PERMISSION_RULES = [
    {
        "tools": ["read_notes"],
        "check": lambda args: not (NOTES_DIR / args["path"])
        .resolve()
        .is_relative_to(NOTES_DIR.resolve()),
        "message": "Access outside notes directory",
    },
    {
        "tools": ["pwsh"],
        "check": lambda args: any(
            keyword in args.get("command", "").casefold()
            for keyword in [
                "remove-item", "rm ", "del ", "erase ", "rmdir ", "rd ",
                "clear-content", "set-content", "add-content", "out-file",
                "move-item", "copy-item", "rename-item", "set-itemproperty",
                "remove-itemproperty", "set-executionpolicy", "stop-process",
                "stop-service", "restart-service", "set-service",
                "set-netfirewallprofile", "new-netfirewallrule",
                "remove-netfirewallrule", "set-mppreference",
                "invoke-expression", "iex ", "invoke-webrequest", "iwr ",
                "start-process", "cmd.exe",
            ]
        ),
        "message": "Potentially destructive command",
    },
]


def check_deny_list(command: str) -> str | None:
    """检查不可批准的命令；命中时返回阻止原因，否则返回 ``None``。"""

    # PowerShell 命令和参数名不区分大小写，统一大小写后再匹配。
    normalized_command = command.casefold()
    for pattern in DENY_LIST:
        if pattern in normalized_command:
            return f"Blocked: '{pattern}' is on the deny list"
    return None


def check_rules(tool_name: str, args: dict[str, Any]) -> str | None:
    """返回第一条命中的审批理由；没有风险规则命中时返回 ``None``。"""

    # 当前采用 first-match 策略；未来规则带优先级时可由 Policy Engine 统一裁决。
    for rule in PERMISSION_RULES:
        if tool_name in rule["tools"] and rule["check"](args):
            return str(rule["message"])
    return None


def ask_user(tool_name: str, args: dict[str, Any], reason: str) -> str:
    """在 CLI 中同步请求安全审批，并返回标准化的 allow/deny 结果。

    这是 Permission HITL。未来支持暂停恢复时，它应返回结构化审批请求，而不是
    直接调用 ``input``；当前写法刻意保留原 Demo 的同步交互方式。
    """
    print(f"\n\033[33m[permission] {reason}\033[0m")
    print(f"   Tool: {tool_name}({args})")
    choice = input("   Allow? [y/N] ").strip().lower()
    return "allow" if choice in ("y", "yes") else "deny"

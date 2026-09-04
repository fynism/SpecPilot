"""Permission checks and command approval for tool execution."""

from typing import Any

from specpilot.config import NOTES_DIR


DENY_LIST = [
    "clear-disk", "format-volume", "initialize-disk", "remove-partition",
    "diskpart", "stop-computer", "restart-computer", "shutdown.exe",
    "bcdedit", "vssadmin delete shadows",
]

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
    """Return a block reason for commands that can never be approved."""
    normalized_command = command.casefold()
    for pattern in DENY_LIST:
        if pattern in normalized_command:
            return f"Blocked: '{pattern}' is on the deny list"
    return None


def check_rules(tool_name: str, args: dict[str, Any]) -> str | None:
    """Return the approval reason for the first matching permission rule."""
    for rule in PERMISSION_RULES:
        if tool_name in rule["tools"] and rule["check"](args):
            return str(rule["message"])
    return None


def ask_user(tool_name: str, args: dict[str, Any], reason: str) -> str:
    """Ask the user to approve a potentially risky tool call."""
    print(f"\n\033[33m[permission] {reason}\033[0m")
    print(f"   Tool: {tool_name}({args})")
    choice = input("   Allow? [y/N] ").strip().lower()
    return "allow" if choice in ("y", "yes") else "deny"


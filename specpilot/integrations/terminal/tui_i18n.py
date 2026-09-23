"""集中管理全屏 TUI 自身的可切换界面文案。"""

from __future__ import annotations

from typing import Final, Literal

TuiLocale = Literal["zh-CN", "en-US"]
SUPPORTED_TUI_LOCALES: Final[tuple[TuiLocale, ...]] = ("zh-CN", "en-US")

_CATALOGS: Final[dict[TuiLocale, dict[str, str]]] = {
    "zh-CN": {
        "status.waiting": "等待输入",
        "status.running": "Agent 正在运行…",
        "status.clarification": "等待你的澄清选择",
        "status.continuing": "Agent 正在继续…",
        "status.tool_limit": "本轮达到工具调用上限，可继续下一轮",
        "status.failure": "Agent 运行失败：{error}；本轮已标记为中断",
        "notice.cannot_cancel": "Agent 正在运行，当前版本不能安全中断模型或工具调用。",
        "notice.interrupted": "上一轮未完整结束，系统不会自动重放模型或工具调用。",
        "notice.switch_failed": "无法切换 Session：{error}",
        "notice.locale_changed": "界面语言已切换为简体中文。",
        "notice.locale_invalid": "不支持的界面语言：{locale}。可选值：zh-CN、en-US。",
        "transcript.omitted": "── 更早还有 {count} 条可读消息未显示 ──",
        "transcript.welcome": "欢迎使用 SpecPilot。",
        "transcript.get_started": "输入需求，或输入 / 查看可用命令。",
        "transcript.runtime": "── 运行信息 ──",
        "role.user": "你",
        "role.assistant": "SpecPilot",
        "header.spec": "Spec",
        "help": "/ 命令 · Tab 补全/确认 · PgUp/PgDn 滚动 · Ctrl+End 回底部 · Ctrl+Q 退出",
        "clarification.title": "需要确认：{question}",
        "clarification.reason": "原因：{reason}",
        "clarification.recommended": " [推荐]",
        "clarification.recommendation": "推荐理由：{reason}",
        "clarification.help": "↑↓ 选择 · Tab 显式选中 · 可输入补充 · Enter 确认 · Esc 取消",
        "session.title": "切换 Session",
        "session.page": "第 {current}/{total} 页",
        "session.help": "↑↓ 选择 · PgUp/PgDn 或 p/n 翻页 · Enter 确认 · Esc 取消",
        "language.title": "界面语言",
        "language.help": "↑↓ 选择 · Enter 确认 · Esc 取消",
        "language.zh-CN": "简体中文",
        "language.en-US": "English",
        "command.new.usage": "/new [标题]",
        "command.new.description": "创建并切换到新 Session",
        "command.sessions.usage": "/sessions",
        "command.sessions.description": "列出当前 worktree 的 Session",
        "command.switch.usage": "/switch [session-id]",
        "command.switch.description": "选择或直接切换 Session",
        "command.rename.usage": "/rename <标题>",
        "command.rename.description": "重命名当前 Session",
        "command.status.usage": "/status",
        "command.status.description": "显示当前 Session 与 Spec 状态",
        "command.done.usage": "/done",
        "command.done.description": "结束澄清并总结已有信息",
        "command.language.usage": "/language [zh-CN|en-US]",
        "command.language.description": "切换全屏界面语言",
        "command.quit.usage": "/quit",
        "command.quit.description": "退出 SpecPilot",
    },
    "en-US": {
        "status.waiting": "Ready",
        "status.running": "Agent is running…",
        "status.clarification": "Waiting for your clarification",
        "status.continuing": "Agent is continuing…",
        "status.tool_limit": "Tool-call limit reached; you can continue in the next turn",
        "status.failure": "Agent failed: {error}; this turn was marked interrupted",
        "notice.cannot_cancel": "The Agent is running and cannot be safely interrupted yet.",
        "notice.interrupted": "The previous turn was interrupted and will not be replayed.",
        "notice.switch_failed": "Unable to switch Session: {error}",
        "notice.locale_changed": "Interface language changed to English.",
        "notice.locale_invalid": "Unsupported interface language: {locale}. Use zh-CN or en-US.",
        "transcript.omitted": "── {count} earlier readable messages are hidden ──",
        "transcript.welcome": "Welcome to SpecPilot.",
        "transcript.get_started": "Enter a request, or type / to view commands.",
        "transcript.runtime": "── Runtime information ──",
        "role.user": "You",
        "role.assistant": "SpecPilot",
        "header.spec": "Spec",
        "help": " ".join(
            (
                "/ commands · Tab complete/confirm · PgUp/PgDn scroll ·",
                "Ctrl+End follow · Ctrl+Q exit",
            )
        ),
        "clarification.title": "Clarification needed: {question}",
        "clarification.reason": "Reason: {reason}",
        "clarification.recommended": " [recommended]",
        "clarification.recommendation": "Why recommended: {reason}",
        "clarification.help": "↑↓ select · Tab mark · optional text · Enter confirm · Esc cancel",
        "session.title": "Switch Session",
        "session.page": "Page {current}/{total}",
        "session.help": "↑↓ select · PgUp/PgDn or p/n page · Enter confirm · Esc cancel",
        "language.title": "Interface language",
        "language.help": "↑↓ select · Enter confirm · Esc cancel",
        "language.zh-CN": "简体中文",
        "language.en-US": "English",
        "command.new.usage": "/new [title]",
        "command.new.description": "Create and switch to a new Session",
        "command.sessions.usage": "/sessions",
        "command.sessions.description": "List Sessions in this worktree",
        "command.switch.usage": "/switch [session-id]",
        "command.switch.description": "Select or directly switch Session",
        "command.rename.usage": "/rename <title>",
        "command.rename.description": "Rename the current Session",
        "command.status.usage": "/status",
        "command.status.description": "Show current Session and Spec status",
        "command.done.usage": "/done",
        "command.done.description": "Stop clarification and summarize known information",
        "command.language.usage": "/language [zh-CN|en-US]",
        "command.language.description": "Change the full-screen interface language",
        "command.quit.usage": "/quit",
        "command.quit.description": "Exit SpecPilot",
    },
}


class TuiTranslator:
    """按稳定键读取 TUI 文案，并允许在运行时切换语言。"""

    def __init__(self, locale: TuiLocale = "zh-CN") -> None:
        self._locale = locale

    @property
    def locale(self) -> TuiLocale:
        """返回当前界面语言。"""

        return self._locale

    def set_locale(self, locale: TuiLocale) -> None:
        """切换当前 TUI 使用的词条目录。"""

        self._locale = locale

    def text(self, key: str, **values: object) -> str:
        """读取并格式化词条；缺失键应在开发期立即暴露。"""

        return _CATALOGS[self._locale][key].format(**values)


def resolve_tui_locale(value: str) -> TuiLocale | None:
    """把用户常用写法规范化为受支持的 TUI locale。"""

    normalized = value.strip().lower().replace("_", "-")
    aliases: dict[str, TuiLocale] = {
        "zh": "zh-CN",
        "zh-cn": "zh-CN",
        "en": "en-US",
        "en-us": "en-US",
    }
    return aliases.get(normalized)


def catalog_keys(locale: TuiLocale) -> frozenset[str]:
    """向完整性测试暴露指定语言拥有的词条键。"""

    return frozenset(_CATALOGS[locale])

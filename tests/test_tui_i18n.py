"""全屏 TUI 词条目录与 locale 解析测试。"""

from specpilot.integrations.terminal.tui_i18n import (
    SUPPORTED_TUI_LOCALES,
    TuiTranslator,
    catalog_keys,
    resolve_tui_locale,
)


def test_all_tui_locales_have_the_same_catalog_keys() -> None:
    """新增 TUI 文案时必须同时补齐所有受支持语言。"""

    baseline = catalog_keys(SUPPORTED_TUI_LOCALES[0])

    assert baseline
    assert all(catalog_keys(locale) == baseline for locale in SUPPORTED_TUI_LOCALES)


def test_tui_translator_switches_catalog_and_formats_values() -> None:
    """同一个稳定键可在运行时切换语言并安全填入动态值。"""

    translator = TuiTranslator()
    assert translator.text("transcript.omitted", count=3) == "── 更早还有 3 条可读消息未显示 ──"

    translator.set_locale("en-US")

    assert (
        translator.text("transcript.omitted", count=3)
        == "── 3 earlier readable messages are hidden ──"
    )


def test_tui_locale_resolver_accepts_common_aliases() -> None:
    """命令参数接受大小写与常用短写，但拒绝未支持语言。"""

    assert resolve_tui_locale("zh_cn") == "zh-CN"
    assert resolve_tui_locale("EN") == "en-US"
    assert resolve_tui_locale("fr") is None

"""提供终端适配器共享的安全文本格式化。"""

import unicodedata


def safe_terminal_text(value: str) -> str:
    """移除控制字符并收敛空白，避免持久化文本改变终端布局或样式。"""

    cleaned = "".join(
        " " if unicodedata.category(character).startswith("C") else character for character in value
    )
    return " ".join(cleaned.split())

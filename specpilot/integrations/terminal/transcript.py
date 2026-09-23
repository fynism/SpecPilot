"""提供全屏 TUI 对话区的角色样式映射。"""

from collections.abc import Callable, Hashable

from prompt_toolkit.document import Document
from prompt_toolkit.formatted_text import StyleAndTextTuples
from prompt_toolkit.lexers import Lexer


class TranscriptLexer(Lexer):
    """依据结构化行样式渲染 Transcript，而不解析显示文本猜测角色。"""

    def __init__(self, style_for_line: Callable[[int], str]) -> None:
        self._style_for_line = style_for_line
        self._revision = 0

    def invalidate(self) -> None:
        """在角色或语言变化后让 prompt_toolkit 丢弃 Lexer 缓存。"""

        self._revision += 1

    def invalidation_hash(self) -> Hashable:
        """返回随 Transcript 重建变化的缓存键。"""

        return self._revision

    def lex_document(self, document: Document) -> Callable[[int], StyleAndTextTuples]:
        """为每一行返回与其结构化角色对应的样式。"""

        def get_line(line_number: int) -> StyleAndTextTuples:
            try:
                text = document.lines[line_number]
            except IndexError:
                return []
            return [(self._style_for_line(line_number), text)]

        return get_line

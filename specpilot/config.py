"""集中管理环境配置与项目级路径。

当前职责：
    从项目根目录的 ``.env`` 读取 Anthropic 客户端配置，并提供其他模块共用的路径
    和常量。集中配置可以避免各模块重复读取环境变量或以不同方式计算目录。

后续扩展：
    可逐步改造成经过 Pydantic 校验的 Settings 对象，增加 CLI 参数、配置文件和环境
    变量的优先级，并加入工作区目录、日志级别、模型预算等 SpecPilot 配置。
"""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# 从包文件位置推导项目根目录，因此从任意工作目录启动都能找到同一份配置。
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"
# CLI 从目标仓库目录启动；解析一次绝对路径，供所有仓库工具共享同一安全边界。
WORKSPACE_ROOT = Path.cwd().resolve()

# 兼容现有传统 Agent Loop 的模块级装配；缺失项只在真正启动 CLI 时由
# load_settings 给出明确错误，因此测试导入模块不需要真实密钥。
load_dotenv(dotenv_path=ENV_FILE, override=True)
API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
BASE_URL = os.getenv("ANTHROPIC_BASE_URL")
MODEL = os.getenv("MODEL_ID", "")
try:
    MAX_TURNS = int(os.getenv("MAX_TURNS", "15"))
except ValueError:
    MAX_TURNS = 15


@dataclass(frozen=True)
class Settings:
    """一次 CLI 运行所需的已校验配置。"""

    api_key: str
    model: str
    base_url: str | None
    max_turns: int


def load_settings() -> Settings:
    """在 CLI 装配阶段加载配置，避免导入模块时产生环境依赖。"""

    # override=True 保留原 Demo 行为：项目 .env 优先于进程中的同名变量。
    load_dotenv(dotenv_path=ENV_FILE, override=True)
    api_key = os.getenv("ANTHROPIC_API_KEY")
    model = os.getenv("MODEL_ID")
    if not api_key:
        raise RuntimeError(f"缺少 ANTHROPIC_API_KEY，请在 {ENV_FILE} 中配置")
    if not model:
        raise RuntimeError(f"缺少 MODEL_ID，请在 {ENV_FILE} 中配置")
    try:
        max_turns = int(os.getenv("MAX_TURNS", "15"))
    except ValueError as exc:
        raise RuntimeError("MAX_TURNS 必须是整数") from exc
    if max_turns < 1:
        raise RuntimeError("MAX_TURNS 必须大于 0")
    return Settings(
        api_key=api_key,
        model=model,
        base_url=os.getenv("ANTHROPIC_BASE_URL"),
        max_turns=max_turns,
    )

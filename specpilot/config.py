"""集中管理环境配置与项目级路径。

当前职责：
    从项目根目录的 ``.env`` 读取 Anthropic 客户端配置，并提供其他模块共用的路径
    和常量。集中配置可以避免各模块重复读取环境变量或以不同方式计算目录。

后续扩展：
    可逐步改造成经过 Pydantic 校验的 Settings 对象，增加 CLI 参数、配置文件和环境
    变量的优先级，并加入工作区目录、日志级别、模型预算等 SpecPilot 配置。
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# 从包文件位置推导项目根目录，因此从任意工作目录启动都能找到同一份配置。
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"
# CLI 从目标仓库目录启动；解析一次绝对路径，供所有仓库工具共享同一安全边界。
WORKSPACE_ROOT = Path.cwd().resolve()

# override=True 保留原 Demo 行为：项目 .env 的值优先于当前进程中的同名变量。
load_dotenv(dotenv_path=ENV_FILE, override=True)

API_KEY = os.getenv("ANTHROPIC_API_KEY")
BASE_URL = os.getenv("ANTHROPIC_BASE_URL")
MODEL = os.getenv("MODEL_ID")
MAX_TURNS = int(os.getenv("MAX_TURNS", 15))

# 在启动阶段尽早失败，比第一次调用模型时才报告缺少配置更容易定位问题。
if not API_KEY:
    raise RuntimeError(f"ANTHROPIC_API_KEY is missing. Set it in {ENV_FILE}")
if not MODEL:
    raise RuntimeError(f"MODEL_ID is missing. Set it in {ENV_FILE}")

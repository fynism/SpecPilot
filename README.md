# SpecPilot

SpecPilot 是一个面向软件项目的需求澄清 Agent。它通过连续的命令行对话调查现有仓库、识别
关键歧义、向用户提供带推荐项的选择，并把确认的信息整理成可校验、可追溯的结构化
Specification（以下简称 Spec）。

项目目前处于 `0.1.0` MVP 阶段，使用 Anthropic 模型，并保留传统 Agent Loop：模型生成响应
并按需调用工具，工具结果返回给模型，循环持续到模型不再调用工具。

## 当前能力

- 连续多轮 CLI 对话，在一次启动中保留消息历史；
- 在工作区边界内列出、搜索和按行读取 UTF-8 仓库文件；
- 用方向键选择澄清选项，默认高亮推荐项，同时支持直接输入或为选项补充文字；
- 管理包含目标、范围、需求、决策、假设、未决问题、验收条件和证据的结构化 Spec；
- 确定性校验 Spec 的阻塞问题与验收覆盖；
- 将 Spec 导出为 JSON 事实源和 Markdown 阅读视图；
- 用户明确结束澄清后，执行一次不开放任何工具的最终总结。

## 环境要求

- Python 3.11 或更高版本；
- 可用的 Anthropic API Key；
- 推荐使用 [uv](https://docs.astral.sh/uv/) 管理虚拟环境和锁定依赖。

## 安装与配置

使用 uv：

```powershell
uv sync --all-extras
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

然后编辑 `.env`：

```dotenv
ANTHROPIC_API_KEY=你的_API_Key
MODEL_ID=要使用的模型标识
ANTHROPIC_BASE_URL=
MAX_TOOL_USE_TURNS=20
```

`ANTHROPIC_BASE_URL` 是可选项；`MAX_TOOL_USE_TURNS` 必须是大于 0 的整数。不要提交包含
真实密钥的 `.env` 文件。

也可以使用传统 pip 虚拟环境：

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

只安装运行依赖时，将 `requirements-dev.txt` 替换为 `requirements.txt`。

## 使用方法

启动 CLI：

```powershell
uv run specpilot
```

兼容入口仍然可用：

```powershell
uv run python code.py
```

启动后直接描述需求，例如：

```text
SpecPilot >> 我想为这个项目增加导出功能，请先调查现有代码并帮我补全需求。
```

出现澄清问题时，可以使用：

- `↑` / `↓`：移动并选中选项；
- 直接输入文字：不选择预设项，提交自己的回答；
- 输入文字后再使用方向键：把文字作为所选项的补充条件；
- `Tab`：选中或取消当前高亮项；
- `Enter`：确认当前答案；
- `Esc` 或 `Ctrl+C`：取消当前澄清。

输入 `/done`、`到此为止`、`先到这里`、`停止澄清` 等明确结束语后，Agent 的下一次响应只会
总结当前已知信息和未决项，不会调用任何工具。该响应结束后仍可继续输入新需求。主提示符下
输入 `q`、`exit` 或空输入可以退出整个 CLI。

当用户要求导出，或 Agent 判断 Spec 已具备评审条件时，文件会写入：

```text
.specpilot/specs/<spec_id>/spec.json
.specpilot/specs/<spec_id>/SPEC.md
```

当前消息历史和结构化 Spec 只保存在进程内；退出前应导出需要保留的内容。

## 工程检查

```powershell
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest
```

默认测试不调用真实模型；需要真实 API 的付费 Eval 必须通过单独开关启用。

## 项目结构

```text
specpilot/
├── cli.py             # 命令行入口
├── runtime/           # Agent Loop、Hook 和模型接口
├── tooling/           # 通用工具契约、注册与执行机制
├── capabilities/      # 仓库调查、需求澄清和 Spec 能力
├── integrations/      # Anthropic 等外部系统适配器
└── evaluation/        # Eval 数据模型与评分
```

工程约定与扩展方式请参阅 [工程手册](docs/engineering/README.md)，产品范围请参阅
[CLI MVP 产品需求文档](docs/product/mvp-prd.md)。Skill Loader、上下文压缩、MCP Tool Calling、
持久化 Session 和 Permission HITL 尚未实现。

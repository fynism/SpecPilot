# SpecPilot

SpecPilot 是一个面向软件项目的需求澄清 Agent。它通过连续的命令行对话调查现有仓库、
识别关键歧义、向用户提供带推荐项的选择，并把确认后的信息整理成可校验、可追溯的
结构化 Specification（以下简称 Spec）。

项目目前处于 `0.1.0` MVP 阶段，使用 Anthropic 模型，并保留了便于学习和理解的传统
Agent Loop：模型生成响应并按需调用工具，工具结果返回给模型，循环持续到模型不再调用工具。

## 当前能力

- **连续多轮 CLI 对话**：一次启动中可以持续补充需求，消息历史会在各轮之间保留。
- **只读仓库调查**：Agent 可以列出文件、搜索文本和按行读取 UTF-8 文件；访问范围被限制在
  启动命令所在的工作区内。
- **选项式需求澄清**：遇到高影响歧义时，Agent 可以提出一个问题和 2～5 个互斥选项，标明
  推荐项及理由；用户也可以输入自定义答案。
- **结构化 Spec 管理**：Agent 可以记录目标、范围、需求、决策、假设、未决问题、验收条件
  和证据，并通过版本号保护更新一致性。
- **确定性校验**：在声称 Spec 可供审批前，检查目标、阻塞问题以及需求与验收条件的覆盖关系。
- **双格式导出**：将当前 Spec 导出为 JSON 事实源和便于阅读的 Markdown 文档。
- **可扩展的运行边界**：模型适配器、Agent Runtime、通用工具机制和具体业务能力已经分离，
  便于后续逐步引入新的能力。

## 环境要求

- Python 3.11 或更高版本
- 一个可用的 Anthropic API Key
- 推荐使用 [uv](https://docs.astral.sh/uv/) 管理虚拟环境和锁定依赖

## 安装与配置

### 使用 uv（推荐）

在项目根目录执行：

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

`ANTHROPIC_BASE_URL` 是可选项；直接使用 Anthropic 官方接口时可以留空。
`MAX_TOOL_USE_TURNS` 表示一次 Agent Loop 最多执行多少轮工具调用，必须是大于 0 的整数。
不要提交包含真实密钥的 `.env` 文件。

### 使用传统 pip 虚拟环境

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

只安装运行依赖时，将 `requirements-dev.txt` 替换为 `requirements.txt`。

## 启动 CLI

使用 uv：

```powershell
uv run specpilot
```

也可以使用兼容入口：

```powershell
uv run python code.py
```

启动后直接用自然语言描述需求，例如：

```text
SpecPilot >> 我想为这个项目增加导出功能，请先调查现有代码并帮我补全需求。
```

Agent 会根据需要调查仓库、更新 Spec 或发起澄清。当出现澄清选项时：

- 输入选项编号并按回车，确认对应答案；
- 直接按回车，确认标有“推荐”的默认选项；
- 选择“其他方案”后，可以输入自定义答案；
- 输入 `q` 可以取消当前澄清。

完成一轮回答后仍可继续补充条件或要求导出。主提示符下输入 `q`、`exit` 或直接提交空输入
即可退出 CLI。

## Spec 导出

当用户要求导出，或 Agent 判断 Spec 已具备评审条件时，导出工具会在当前工作区写入：

```text
.specpilot/specs/<spec_id>/spec.json
.specpilot/specs/<spec_id>/SPEC.md
```

`spec.json` 是结构化事实源，`SPEC.md` 是由同一份数据确定性生成的阅读视图。
`.specpilot/` 默认不会提交到 Git。

## 运行检查

执行完整工程检查：

```powershell
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest
```

如果已经激活 `.venv`，也可以直接运行对应命令。默认测试不会调用真实模型；需要真实 API 的
付费 Eval 会单独控制，不会在普通测试中意外执行。

## 当前限制

- 当前只有 CLI 入口和 Anthropic 模型适配器。
- 消息历史和结构化 Spec 只保存在当前进程内；退出前应主动导出需要保留的 Spec。
- 当前没有 `/spec`、`/status`、`/approve` 等斜杠命令。
- Skill Loader、上下文压缩、MCP Tool Calling、持久化 Session 和 Permission HITL 尚未实现。
- 当前实现用于验证 MVP 架构与交互方式，不应视为完整的生产级 Agent 平台。

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

工程约定和扩展方式请参阅 [工程手册](docs/engineering/README.md)，MVP 的产品范围请参阅
[CLI MVP 产品需求文档](docs/product/mvp-prd.md)。`uv.lock` 是可复现依赖快照；依赖升级应通过
`uv lock` 有意识地更新，并与行为变更分开提交。

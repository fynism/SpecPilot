# SpecPilot

SpecPilot 是面向软件项目的需求澄清 CLI。它调查现有仓库、识别关键歧义，通过连续对话确认
需求，并生成可校验、可追溯的结构化 Specification。当前版本为 `0.1.0`，使用 TypeScript、
Node.js、Ink 与 Anthropic 官方 SDK，没有额外的 Agent 编排框架。

## 安装与配置

需要 Node.js **22.12 或更高版本**。从源码安装和验证：

```powershell
npm ci
npm run build
```

在目标工作区创建 `.env`（可复制本仓库的 `.env.example`）：

```dotenv
ANTHROPIC_API_KEY=你的_API_Key
MODEL_ID=要使用的模型标识
ANTHROPIC_BASE_URL=
MAX_TOOL_USE_TURNS=20
```

保留原环境变量名称、默认工具轮次 `20` 和 `.env` 优先于同名进程变量的行为。
`MAX_TOOL_USE_TURNS` 必须是正整数；`ANTHROPIC_BASE_URL` 可选。不要提交真实密钥。
配置在启动时读取，导入模块、查看帮助或版本不需要 API Key。

```powershell
# 在本仓库启动
npm start

# 开发模式
npm run dev

# 本地打包安装，验证 npm CLI 分发
npm pack
npm install --global .\specpilot-0.1.0.tgz

# 安装后在目标仓库中启动
specpilot
specpilot --help
specpilot --version
```

也可以在任意目标仓库运行 `node <本仓库绝对路径>/dist/cli.js`。本仓库尚未要求发布到
npm registry；以上打包和安装都可以在本地完成。

## 使用

在 CLI 中直接描述需求。交互终端进入 Ink 全屏界面，退出后恢复原终端；管道和 CI 使用
普通逐行控制台，不输出 ANSI 清屏或颜色控制序列。

```text
/new [标题]           创建并切换 Session
/sessions             列出当前 worktree 的 Session
/switch [session-id]   无参数时选择，传完整 ID 时直接切换
/rename <标题>        重命名当前 Session
/status               显示当前 Session 和 Spec 状态
/compact              手动压缩当前上下文，保留原始历史
/done                 结束澄清，只总结已有信息
/language [zh-CN|en-US] 切换全屏界面语言
/quit                 退出
```

全屏界面支持斜杠命令提示、Tab 补全、输入历史、PgUp/PgDn 翻阅对话、Ctrl+Home 跳到开头、
Ctrl+End 恢复跟随最新消息，以及 Ctrl+Q 退出。用户和 Agent 按结构化角色显示不同颜色。
Session 选择每页 10 项，PgUp/PgDn 或 p/n 翻页，Enter 明确确认，Esc 取消。

底部实时显示当前上下文已用 Token、暂定 **500,000 tokens** 窗口和使用百分比。用量包含
消息、系统提示和工具声明，采用 UTF-8 字节估算，界面明确标注“估算”，不是计费统计。
发送前预留 8,000 tokens 输出预算；接近窗口上限时自动压缩，供应商明确返回 context limit
时压缩并重试一次。可在等待输入时用 `/compact` 手动压缩，运行中不能并发执行该命令。

基础策略用当前模型摘要旧历史，保留最新用户请求、近期完整工具配对及当前结构化 Spec。
大历史分批摘要，不调用工具；摘要可能丢失细节，原始历史仍保留在 Session 中并用于显示。
压缩失败不替换原上下文；历史太短且摘要没有收益时保持原样。单条消息过大或压缩后仍超限
会明确失败，可缩短输入或创建新 Session。策略后续可独立优化。

澄清界面默认高亮推荐项；只有用户提交后才形成答案。方向键选择其他选项；直接输入是自由
回答；输入文字后按方向键或 Tab，可同时提交选项与补充。Enter 提交，Esc/Ctrl+C 取消。
管道模式使用编号选择，空行主动确认推荐项，也允许直接输入回答。

`/done`、`到此为止`、`先到这里`、`停止澄清` 等完整结束表达会让下一轮只总结已知信息。
Runtime 不向模型开放工具，也会拒绝异常返回的工具调用；用户在澄清界面输入结束语后，同批
后续工具同样被拒绝。总结后可继续输入新需求。管道模式兼容 `q`、`exit` 和空输入退出。

## 功能与兼容边界

- 保留列目录、搜索、按行读取、澄清、读取 Spec、原子 Patch、校验和导出八个工具；
- Spec 保留目标、范围、需求、决策、假设、未决问题、验收条件和证据；Zod 严格校验输入及引用；
- Spec 采用乐观版本校验和整批 Patch 提交，非法修改不影响旧状态；
- 每个 Session 独占历史与 Spec，重启恢复上次活动项；未完成轮次标记中断并且不自动重放；
- 文件路径在解析符号链接后复验工作区边界，状态文件采用同目录临时文件加原子替换；
- 语言切换只改变当前进程的 UI 文案，不翻译历史、Spec、系统提示或模型回答。

旧 Python `schema_version=1` 的 Session 可继续读取，按需迁移为带上下文摘要的 Session v2；
原始消息、Spec JSON、ID、版本历史和目录格式保留。旧版程序不能读取 Session v2，回退方法见
[状态与记忆](docs/engineering/state-and-memory.md)。

```text
.specpilot/sessions/index.json
.specpilot/sessions/<session_id>/session.json
.specpilot/specs/<spec_id>/spec.json
.specpilot/specs/<spec_id>/SPEC.md
```

Python CLI、`code.py`、pip/uv 依赖与旧 Python 测试已移除；使用上面的 npm 命令启动。
`.env` 现在从**启动工作区**读取，npm 安装位置不作为配置根目录。

MVP 仍只支持单进程写入和完整轮次之间恢复；不支持工具执行中 checkpoint、跨 worktree
共享或安全中断正在执行的模型/工具调用。运行时 UI 会明确拒绝强制退出操作。
Skill Loader、MCP 和 Permission HITL 尚未实现。

## 工程验证

```powershell
npm run build
npm run typecheck
npm run lint
npm run tests
npm run smoke:package
```

`lint` 同时检查 Biome 格式和静态规则，`npm run format` 自动格式化。默认测试不联网，覆盖
状态、工具、Anthropic 模拟协议、Python JSON 迁移、六个原有场景的受控执行轨迹和 Ink 按键。
这些脚本化轨迹验证运行时契约，不能替代真实模型的概率性评估。

原付费 Eval 仍通过 `SPECPILOT_RUN_LIVE_EVALS=1` 单独启用，默认跳过。CI 在 Windows 和
Linux 的 Node 22 上执行所有确定性检查和打包检查。

```text
src/
├── cli.tsx / config.ts / bootstrap.ts  # 入口、配置与组合根
├── runtime/                           # Agent Loop、Hook、Session 和模型端口
├── tooling/                           # 工具契约、注册、校验与统一执行
├── capabilities/                      # 仓库调查、澄清和 Spec
├── integrations/                      # Anthropic、文件系统和 Ink / console
└── evaluation/                        # Eval 契约与评分
tests-ts/                              # 离线回归和兼容样本
```

工程约定见 [工程手册](docs/engineering/README.md)，迁移验收记录见
[TypeScript 迁移计划](docs/plans/261008-TypeScript迁移.md)。

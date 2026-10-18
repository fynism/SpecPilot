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

安装 CLI 后，在目标工作区运行 `specpilot`。交互终端中缺少配置时会自动进入配置向导；
也可以随时通过 `specpilot config` 修改用户配置。源码运行使用 `npm run dev -- config`。

配置按以下顺序输入：

1. API 协议：Anthropic 或 OpenAI 兼容协议，仅配置第三方 API。
2. Base URL：服务商提供的 HTTPS API Base URL，保留合法路径前缀（例如 `/proxy/v1`）；
   不能包含账号、查询参数或片段，不填写完整的消息接口地址。
3. 模型 ID：手动输入服务商提供的模型标识。
4. API Key：输入内容遮蔽，支持粘贴。编辑时留空保留已有 Key；协议或 URL 改变后必须重新输入。

配置默认保存到当前用户的 `~/.specpilot/config.json`（Windows 中 `~` 对应用户目录），
跨工作区复用，不修改项目 `.env`。**API Key 以明文存储**，文件限制为当前用户访问；
Unix 使用目录 `0700`、文件 `0600`，Windows 使用当前用户 SID 的文件 ACL。
不自动发送连接验证请求，保存成功不代表第三方服务兼容。

`specpilot config` 保存后退出；首次启动完成 Anthropic 配置后继续进入应用。
OpenAI 目前只支持填写和保存，运行时会明确拒绝，不回落到 Anthropic。
Esc / Ctrl+C 取消不保存；保存失败保留旧配置。配置文件损坏、读取失败或版本不兼容时明确报错，
请修复配置文件后重试，不会自动重置。

管道和 CI 不启动配置向导；缺少配置或执行 `specpilot config` 时以非零退出码退出。
可以提前完成用户配置，或通过以下旧 `.env` / 进程环境变量方式提供配置：

```dotenv
ANTHROPIC_API_KEY=你的_API_Key
MODEL_ID=要使用的模型标识
ANTHROPIC_BASE_URL=
MAX_TOOL_USE_TURNS=20
```

兼容读取规则：

- 先合并进程环境与工作区 `.env`，`.env` 中的同名变量优先。
- 只要存在 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_BASE_URL`（包括空值），就整组使用旧 Anthropic
  连接配置，不从用户文件补齐 Key 或 URL。旧模式下 `ANTHROPIC_BASE_URL` 仍可省略。
- 没有旧连接字段时使用用户配置；`MODEL_ID` 可独立覆盖用户配置中的模型 ID。
- `MAX_TOOL_USE_TURNS` 必须是正整数，默认 `20`。

保存配置时显示文件位置和实际生效来源。旧连接配置覆盖用户配置时会提示；
如需使用用户配置，请移除旧连接字段，不能仅将其留空。
不要提交 `.env` 或真实密钥。配置在启动时读取，导入模块、查看帮助或版本不需要 API Key。

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
specpilot config
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
/clarify [需求描述]   带描述开始梳理需求；无参数查看已有进度
/compact              手动压缩当前上下文，保留原始历史
/done                 结束澄清，只总结已有信息
/language [zh-CN|en-US] 切换全屏界面语言
/quit                 退出
```

全屏界面支持斜杠命令提示、Tab 补全、输入历史、PgUp/PgDn 翻阅对话、Ctrl+Home 跳到开头、
Ctrl+End 恢复跟随最新消息，以及 Ctrl+Q 退出。用户和 Agent 按结构化角色显示不同颜色。
Session 选择每页 10 项，PgUp/PgDn 或 p/n 翻页，Enter 明确确认，Esc 取消。

普通输入用于聊天、解释与只读调查，不会修改或导出 Spec，也不会自动处理待提交/待处理答案。
使用 `/clarify <需求描述>` 显式开始：入口先使用当前模型、空工具集判断描述是否包含可讨论的产品需求；
无关内容、过宽目标或与现有需求无关的新任务会得到普通回复，后续通过该命令补充目标，或先 `/new`。
无参数 `/clarify` 只打开已有进度；没有进度时显示命令用法，不从聊天历史提取需求。

入口通过后，Agent 先调查仓库，再发布本轮问题并返回澄清总览。总览包含全部已识别主题和待细化事项，
每轮按依赖与优先级自适应发布一至三题，不为填满轮次而追加问题。用户可任意顺序作答、暂缓或回改；编辑期间不调用模型。
答案先保存为草稿，按 `c` 才统一提交给下一轮 Agent；草稿和补充说明重启后仍保留。

总览按 `Tab` 切换本轮／全部主题，方向键与 PgUp/PgDn 导航，Enter 编辑问题或展开主题；
`d` 暂缓／恢复，`h` 查看修订历史，`n` 补充说明，`r` 显式重试，`x` 结束澄清，`b` 返回对话。
历史中方向键切换修订，PgUp/PgDn 阅读全文。问题编辑器默认高亮推荐项，只有 Enter 才保存
答案；直接输入是自由回答，Tab 可同时选中方向并保留补充。Esc 取消不会确认推荐项。
窄屏问题编辑器可通过 Ctrl+O 打开完整详情，PgUp/PgDn 翻页，查看详情不会丢失正在输入的文字。
Console 使用同等编号菜单，`a` 切换本轮／全部、`d <编号>` 暂缓／恢复、`h <编号>` 查看历史。

暂缓不等于解决，空轮次不等于 Spec 完整。修改已确认答案会标记相关问题与结论需要复核。
空轮次通过宿主完整性检查后，直接返回对话展示可审阅摘要；未通过时说明剩余缺口，不弹出空问卷。
从面板返回聊天不会结束或推进需求；只有面板提交、重试或带描述的 `/clarify` 才继续处理。
运行失败时保留提交并标记可重试；系统不自动重放。运行中的总览只读。
底部实时显示两种独立统计：

- **上下文占用**：优先调用供应商 `countTokens`，计入实际发送的消息、系统提示和工具声明，
  显示暂定 **500,000 tokens** 窗口与百分比。启动、恢复或上下文变化后尚未计数时显示
  “待计数”；计数接口明确不支持时回退到带“估算”标记的 UTF-8 字节估算。供应商计数是
  发送前计数，可能与最终 usage 有少量差异。
- **实际消耗**：读取每次模型响应的 `usage`，显示本次操作及累计输入+输出 tokens。
  输入数包含缓存读取和创建，普通回答和压缩摘要均计入，计数请求不计为生成消耗。
  `/status` 可查看本次与累计输入、输出明细。调用失败或服务缺失/非法 usage 时显式标注
  统计不完整，不把文本估算填成实际消耗。

发送前使用供应商计数判断预算，并预留 8,000 tokens 输出；接近窗口上限时自动压缩。
供应商明确返回 context limit 时压缩并重试一次。可在等待输入时用 `/compact` 手动压缩，
运行中不能并发执行该命令。计数向当前配置的同一服务发送模型请求上下文；不访问第二个服务。
计数接口的认证、限流、网络及非法响应会明确报错，只有不支持接口时才回退。
部分兼容服务在“工具声明 + assistant 收尾”时拒绝 thinking 内容计数；识别到明确的此类
校验错误时，等待输入阶段显示“上下文（估算）”，下一次 user 输入后仍按供应商精确计数。
不关闭模型思考，也不把其他 HTTP 400 静默忽略。
本轮完成后用于显示的计数刷新失败时，保留回答和需求结果并提示“计数暂不可用”；下一次
发送前仍严格检查，不把已完成回答撤回，也不使用估算掩盖服务错误。

基础策略用当前模型摘要旧历史，保留最新用户请求、近期完整工具配对及当前结构化 Spec。
大历史分批摘要，不调用工具；摘要可能丢失细节，原始历史仍保留在 Session 中并用于显示。
压缩失败不替换原上下文；历史太短且摘要没有收益时保持原样。单条消息过大或压缩后仍超限
会明确失败，可缩短输入或创建新 Session。策略后续可独立优化。

`/done`、`到此为止`、`先到这里`、`停止澄清` 等完整结束表达会让下一轮只总结已知信息。
Runtime 不向模型开放工具，也会拒绝异常返回的工具调用；未提交草稿不会成为已确认结论。
总结后恢复只读对话，通过 `/clarify <需求描述>` 再次处理需求。管道模式兼容 `q`、`exit` 和空输入退出。

## 功能与兼容边界

- 澄清轮次提供九个工具；普通聊天只提供六个只读工具（仓库调查、总览读取、Spec 读取和校验），执行器也拒绝越界写调用；
- 原阻塞式单题澄清服务保留兼容契约，但默认 CLI 不向模型暴露该工具；
- 精简 Spec 保留单一目标、边界、需求（内含验收示例）、用户确认的产品决策和来源证据；未决问题留在澄清总览；
- Spec 采用乐观版本校验和整批 Patch 提交，非法修改不影响旧状态；
- 每个 Session 独占历史与 Spec，重启恢复上次活动项；未完成轮次标记中断并且不自动重放；
- 文件路径在解析符号链接后复验工作区边界，状态文件采用同目录临时文件加原子替换；
- 语言切换只改变当前进程的 UI 文案，不翻译历史、Spec、系统提示或模型回答。

Session v5 保存精简 Spec v2、澄清总览、压缩上下文和实际 Token 消耗。旧格式不自动迁移；旧目录内容保持原样，需由旧版本程序读取。新目录为：

```text
.specpilot/sessions-v5/index.json
.specpilot/sessions-v5/<session_id>/session.json
.specpilot/specs/<spec_id>/spec.json
.specpilot/specs/<spec_id>/SPEC.md
```

旧程序不会读取 v5 新目录；回退后 v5 期间产生的交互数据不会出现在旧程序中。详见 [状态与记忆](docs/engineering/state-and-memory.md)。

Python CLI、`code.py`、pip/uv 依赖与旧 Python 测试已移除；使用上面的 npm 命令启动。
`.env` 现在从**启动工作区**读取，npm 安装位置不作为配置根目录。

MVP 仍只支持单进程写入和完整轮次之间恢复；不支持工具执行中 checkpoint、跨 worktree
共享或安全中断正在执行的模型/工具调用。运行时 UI 会明确拒绝强制退出操作。
Skill Loader、MCP 和 Permission HITL 尚未实现。

多轮行为评测与真实模型成本／质量对比方法见 [澄清评测](evals/clarification-rounds.md)。

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

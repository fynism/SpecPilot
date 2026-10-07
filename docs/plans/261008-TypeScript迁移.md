# TypeScript CLI 迁移

范围：保持 0.1.0 主要功能、工具名称和参数、环境变量、schema_version=1 的 Spec / Session JSON 兼容。
只在 refactor/ts 分支本地提交，不 push，不操作远端。

## 阶段与验收

1. Node 工程与 Zod 契约：严格类型、输入校验、历史数据 fixture、配置与原 Python 离线基线。
2. 能力与持久化：8 个工具的底层能力、版本冲突、引用与证据、工作区路径边界、原子 Session 恢复。
3. 运行时与 Ink CLI：保留 Prompt，统一 Executor / Hook、轮次预算、最终总结禁用工具；Ink 全屏双语交互、非 TTY 管道。
4. 清理与分发：删除 Python CLI / 依赖 / 测试（回归迁到 TypeScript），更新工程手册和 npm CI；全检查、打包安装、CLI 冒烟。

各阶段运行 build、typecheck、lint 与对应 tests，确认可用后提交中文 Conventional Commit。

## 完成条件与 Eval

- 原有工具 / Spec / Session 字段和状态语义保留，Python 生成的持久化 fixture 可以加载、修改和再次恢复。
- 确定性 Eval 覆盖调查、两次澄清、原子 Spec 更新、校验、导出、越界拒绝、工具失败与中断恢复。
- 用户 /done 或澄清内结束语禁用所有后续工具（包括同批剩余工具），模型异常返回 tool_use 也拒绝。
- Ink 保留推荐项明确确认、自由输入及选项补充、取消、Session 分页选择、命令提示 / 补全、对话翻阅与语言切换。
- npm 包安装后可运行 specpilot --help / --version，非交互不输出控制序列。
- build、typecheck、lint、tests 全通过，无生产 Python 依赖。

## 依赖选择

使用 Node 22.12+ ESM；TypeScript 负责静态类型，Zod 4 提供严格校验和原生 JSON Schema；Ink / React 与 @inkjs/ui
负责终端 UI；官方 Anthropic SDK 保留供应商接口；dotenv 保留 .env 行为。测试用 Vitest 与 Ink testing library，
Biome 统一格式和静态 lint。无 Agent 框架，文件系统使用 Node 内置模块。
以上库为维护中的主流实现（Ink 和 UI 使用 MIT，React / Zod / dotenv / TypeScript / Vitest 使用 MIT，
Anthropic SDK 使用 Apache-2.0，Biome MIT/Apache-2.0）；锁文件固定依赖。避免重复手写验证器或终端渲染器，
不增加数据库、编排框架和打包器。

## 完成记录

四个迁移阶段均已完成。原 Python 离线基线为 111 项通过、1 项真实模型 Eval 跳过。
最终 TypeScript 验收覆盖原行为契约，不以测试条数对应逐个 Python 测试文件。

已提交的阶段和回归修复：

- `a51a288`：Node 工程、配置与 Zod 数据契约。
- `45ad5eb`：仓库调查、Spec 能力与版本化 Session 持久化。
- `dba5295`：Agent Loop、统一 Executor / Hook、Anthropic 适配与 Ink / console CLI。
- `5723af1`：固定安全测试依赖；npm audit 为零漏洞。
- `cbe5d93`：通用 CR / LF / CRLF 换行兼容及回归测试。
- 最后阶段提交：删除 Python CLI、依赖清单与旧测试，保留 Python 生成的兼容样本；
  更新 TypeScript 工程手册、npm 分发验收脚本和双平台 CI 配置。

本地验收（Windows，Node 22.14）：

- `npm ci --offline --no-audit --no-fund` 可从锁文件重新安装。
- `npm run build`、`npm run typecheck`、`npm run lint` 全通过。
- `npm run tests`：63 项通过，1 项真实模型 Eval 未启用。
- `npm run smoke:package`：真实打包、临时项目仅生产依赖安装、npm CLI shim、帮助、版本、
  管道 Session 创建 / 重命名 / 持久化通过；包中没有 Python、测试、密钥或工作区状态。
- Windows PTY：Ink 全屏启动、新建 Session、英语切换、Session 选择和取消、正常退出通过，
  退出恢复原终端。

保留八个工具、系统 Prompt、环境变量名称以及 schema_version=1 的 JSON 格式。
所有模型协议、运行时和脚本化 Eval 测试使用受控替身，没有调用真实模型。
Windows / Linux CI 工作流已配置；未操作远端，未执行远端 CI，Linux 结果尚未验证。

# 独立持久化 Session 实现计划

## 背景

当前 CLI 只在进程内维护一份对话历史，退出后无法恢复，也不能在同一工作目录中保存并切换
多个对话。后续 Context Compaction 还需要明确的 Session、Context 与内容产物边界，否则压缩后
的历史、摘要和工具结果无法可靠归属和恢复。

本计划先实现一个本地优先、单进程使用的持久化 Session MVP，为后续 Context Compaction
提供稳定基础，不改变传统 Agent Loop 的模型—工具循环结构。

## 已确认的产品决定

- `D-SESSION-001`：“多开”表示在同一工作目录中创建多个持久化对话并进行切换，不包含
  并行执行。
- `D-SESSION-002`：Session 绑定当前工作目录（包括具体 Git worktree），不同 worktree
  默认互相隔离。
- `D-SESSION-003`：一个 Session 独占一份对话 Context 和一份结构化 Spec。
- `D-SESSION-004`：恢复与切换只发生在完整 Agent Loop 轮次之间，不支持从工具执行中间
  恢复。
- `D-SESSION-005`：Session 状态默认保存在本地，不进入 Git；需要评审的 Spec 继续通过
  导出能力生成文档。

## 目标

1. `R-SESSION-001`：CLI 重启后可以恢复此前保存的 Session、对话上下文和 Spec。
2. `R-SESSION-002`：同一工作目录可以创建、列出、切换和重命名多个 Session。
3. `R-SESSION-003`：不同 Session 的消息、Spec、澄清状态和后续 artifact 不会相互串用。
4. `R-SESSION-004`：每个完整 Agent Loop 结束后形成一致、可恢复的保存点。
5. `R-SESSION-005`：为后续 Context Compaction 提供 Session 标识、当前请求和独立
   artifact 空间。

## 暂不包含

- 多个进程或终端并发写入同一个 Session；
- 在工具调用或模型请求执行中间恢复；
- 跨 worktree 自动共享或迁移 Session；
- 长期记忆、云端同步、数据库和多用户权限；
- Session 合并、分支以及多个 Session 共享同一份 Spec；
- Context Compaction 本身。

## 用户交互

CLI 保留普通输入触发传统 Agent Loop 的方式，并增加少量 Session 命令：

```text
/new [标题]          创建并切换到新 Session
/sessions            列出当前工作目录中的 Session
/switch <session-id>  切换到指定 Session
/rename <标题>        重命名当前 Session
/status               显示当前 Session 和 Spec 状态
/quit                 保存当前状态后退出
```

启动时若存在上次活动的 Session，则自动恢复并显示其标识和标题；不存在时创建一个新 Session。
切换只允许发生在 Agent 等待普通用户输入时。恢复后继续追加对话，不自动重放上一轮工具调用。

## 状态边界

Session State 负责保存单次对话的运行状态，至少包含稳定 ID、标题、生命周期状态、消息历史、
当前请求、关联 Spec ID、创建/更新时间和 Schema 版本。

Spec State 仍是结构化需求事实源。每个 Session 创建时同时获得独立 Spec；切换 Session 时，
Agent 使用该 Session 对应的 Spec Store，`get_spec`、`apply_spec_patch`、`validate_spec` 和
`export_spec` 始终作用于当前 Session。

仓库文件、项目配置和模型配置属于 worktree 级共享环境，不复制进各个 Session。对话历史、
澄清结果、Spec 与未来的 transcript/tool-result artifact 属于 Session 级状态，不能跨 Session
隐式读取。

## 技术实现思路

### Session 模块

在 `runtime/session/` 中定义供应商无关的 Session 模型和生命周期操作，包括创建、加载、列出、
切换、重命名和保存。持久化契约携带 Schema 版本，损坏或不兼容的数据应明确报错，不能猜测
修复。

### 本地持久化适配器

使用工作目录下的 `.specpilot/sessions/` 保存 Session 索引和各自状态。文件写入采用 UTF-8 与
临时文件加原子替换，避免异常退出留下半写文件。该目录加入 `.gitignore`。

建议的逻辑布局如下，具体文件拆分可在实现时保持最小化：

```text
.specpilot/
└── sessions/
    ├── index.json
    └── <session-id>/
        ├── session.json
        ├── messages.json
        ├── spec.json
        ├── transcripts/
        └── artifacts/
```

`transcripts/` 与 `artifacts/` 本阶段只预留归属目录；由后续 Context Compaction 在真正需要时
写入，不提前实现压缩逻辑。

### Agent Runtime 装配

将当前模块级的 Agent 依赖收敛为可按 Session 装配的轻量运行时对象。切换 Session 时重新绑定
它的消息、Spec Store 和未来 Context/Artifact Store；模型客户端和无状态工具定义可以复用。

传统 Agent Loop 保持原有语义：模型请求工具、工具返回结果、模型继续判断，直到不再调用工具
或命中确定性停止条件。Session 只负责在 Loop 外加载输入状态，并在完整轮次结束后保存结果。

### 保存与恢复

用户输入开始一轮 Agent Loop 后，当前 Session 暂时进入运行状态。只有模型响应及其整批
`tool_result` 已经闭合、Loop 返回 CLI 后，才把状态标记为可恢复保存点。

如果进程在一轮中间异常退出，恢复时应明确显示上一轮未完成，并且不自动重复模型或工具调用。
MVP 可以要求用户重新输入或显式继续；更细粒度 checkpoint 留到后续设计。

## 实施阶段

1. 定义 Session 数据模型、生命周期和本地 Store，并覆盖创建、保存、加载与损坏数据测试。
2. 让 Spec Store 按 Session 隔离，验证两个 Session 的读写不会互相影响。
3. 将 Agent 依赖改为按当前 Session 装配，同时保持 Agent Loop 行为不变。
4. 增加 CLI 的创建、列表、切换、重命名和启动恢复流程。
5. 补充端到端测试，验证退出重启、来回切换、Spec 隔离和异常中断提示。
6. 在 Session 边界稳定后，再实现 Session 级 Context State、Artifact Store 与 Context
   Compaction。

结构重构与用户可见功能应分开提交，确保每个提交都可以独立测试和回滚。

## 验收重点

- `AC-SESSION-001`：创建两个 Session 后，各自的消息与 Spec 独立保存。
- `AC-SESSION-002`：在两个 Session 之间多次切换，恢复出的内容始终与对应 Session 一致。
- `AC-SESSION-003`：退出并重新启动 CLI 后，可以恢复上次活动 Session，也可以切换到其他
  已有 Session。
- `AC-SESSION-004`：Session A 的 Spec 工具调用不会读取或修改 Session B 的 Spec。
- `AC-SESSION-005`：切换只能发生在 Agent Loop 轮次之间，系统不会自动重放未完成工具调用。
- `AC-SESSION-006`：持久化数据损坏或 Schema 不兼容时明确失败，不覆盖原文件，也不伪装成
  空 Session。

## 后续衔接

Context Compaction 将建立在本计划的 Session 边界上：每次压缩只处理当前 Session 的 Context，
转存结果写入当前 Session 的 artifact 目录，摘要保留当前请求、Spec 版本和原始 transcript 引用。
长期记忆继续作为独立能力设计，不与 Session 历史或 Spec 混用。

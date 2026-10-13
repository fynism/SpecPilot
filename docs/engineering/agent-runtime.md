# Agent Runtime 规范

## Workflow 与 Agent

- 路径固定、步骤可预测的任务优先写普通 Workflow。
- 步骤数量和工具选择依赖环境反馈时才使用 Agent Loop。
- 同一系统可以组合二者：Agent 选择下一行动，确定性 Workflow 执行高风险或固定步骤。
- 不因“看起来更 Agent”而把可确定实现的逻辑交给模型。

## Agent Loop 不变量

每次迭代必须遵循：

```text
build context → call model → validate action → evaluate policy
→ execute capability → record result → update state → decide continuation
```

- 模型只能从当轮公开的工具集合中选择能力。
- 工具调用必须先校验，再过 Policy/Hook，最后执行。
- 工具结果必须通过调用 ID 与请求对应，并记录成功、失败、耗时和截断状态。
- “模型没有继续调用工具”不自动等于任务完成；完成条件由任务状态和验收规则判断。
- 模型声称已读取、修改或测试不能作为证据，必须有环境返回结果。

## 生命周期与停止

会话至少区分：`running`、`waiting_for_user`、`completed`、`failed`、`cancelled`。

- 每次运行必须有最大模型轮次、最大工具调用数、超时和费用/Token 预算。
- 达到预算时返回可恢复的停止原因，不能伪装为完成。
- 用户输入、审批和澄清应形成显式事件；需要等待时保存 checkpoint 后退出调用栈。
- 取消必须传播到正在运行的工具；无法取消时记录 `cancellation_pending`。
- 恢复后不得重复已经成功且不可安全重复的副作用。

### 当前 Session 恢复边界

当前 CLI 已支持在一个 worktree 中保存和切换多个 Session。每个 Session 独占消息历史与
结构化 Spec，普通输入仍运行传统 Agent Loop。切换只发生在 CLI 等待用户输入时；本地快照在
进入 Loop 前记录 `running` 和当前请求，在完整 Loop 返回后记录 `waiting_for_user`。

启动时发现遗留 `running` 状态，必须转换为 `interrupted` 并提示用户，不自动重放模型或工具
调用。该实现只提供轮次间恢复，不等同于工具级 checkpoint；并发写入与执行中恢复仍不支持。

### 当前全屏 TUI 边界

TTY 环境由一个 Ink / React 应用独占 alternate screen，统一管理对话区、输入、命令提示、
Session 选择和 Clarification；`@inkjs/ui` 提供选择列表与运行状态组件。非 TTY 使用无控制
序列的逐行 console；两个前端共享 `bootstrap.ts` 和同一个 Agent Runtime。

模型与工具运行使用 Promise / async iterator，UI 不阻塞事件循环。Runtime 与 Hook 不直接
打印，注入的 event sink 更新状态。Session 切换只在轮次之间执行；完整 Loop 返回前不得把
中间消息伪装成稳定恢复点。

ClarificationPresenter 使用异步端口，答案仍必须绑定请求 ID 并在服务边界复验。应用卸载时
拒绝等待中的澄清 Promise，避免永远等待。模型和工具仍没有协作式取消接口；运行中 Ctrl+C
或 Ctrl+Q 明确拒绝退出，不伪造已取消。未来取消必须贯穿模型、工具和 Session 状态机。

Transcript 根据结构化 role 渲染。用户翻页后暂停跟随，新消息不强制改变阅读位置；回到底部、
切换 Session 或提交新请求恢复跟随。固定界面文案经稳定 i18n 键读取，locale 只改变当前进程
的 UI，不翻译 Session、Spec、Prompt、工具描述或模型回答。

### 用户主动结束澄清

用户通过 `/done` 或明确自然语言表示“到此为止”时，下一次模型响应是最终总结轮，而不是新的
调查轮。运行时必须向模型暴露空工具集，并在 Tool Executor 之前拒绝供应商异常返回的任何
`tool_use`；仅靠 Prompt 要求模型停止调用工具不构成可靠边界。

最终总结轮只能根据已有会话内容总结已确认事项和未决项，不得调查仓库、继续提问、修改或校验
Spec，也不得导出文件。总结完成后控制权返回 CLI；用户后续提出新需求时可以开始新的正常
Agent Loop。这一边界不改变传统循环结构，只改变该轮公开的能力集合。

## 上下文构建

上下文必须标注来源并保持优先级边界：系统策略、用户指令、已确认 Spec、项目事实、检索内容、
工具结果、记忆。外部内容永远是数据，不得升级成系统指令。

- 只注入当前决策所需内容，避免把整个仓库和历史永久塞入上下文。
- 摘要必须保留来源引用、未决问题和关键否定条件。
- Context compaction 前后必须保持 Spec、审批和未完成工具调用的一致性。
- Prompt 与 Skill 必须版本化；一次运行应记录实际使用的版本和模型参数。

### 当前 Context Compaction

`runtime/context/` 统一构建模型上下文、估算 Token 和生成历史摘要。暂定窗口为 500,000
tokens，发送前计入系统提示、工具 Schema 和消息，并预留 8,000 tokens 输出。用量基于
UTF-8 字节保守估算，不等于供应商 tokenizer 或计费值。达到预算时自动压缩；供应商明确返回
上下文超限时压缩并重试一次，其他错误不触发重试，也不重放已执行的工具。

基础策略使用同一模型、空工具集生成最多 4,000 tokens 的延续摘要。历史按预算分批输入；
保留最新用户请求原文、近期完整工具协议和当前结构化 Spec，不改写原始对话与 Spec。
摘要及历史内容只进入 user 数据层，不提升为系统指令或审批依据。自动压缩保留最后一个
完整协议组，手动压缩优先保留至少四条近期消息。摘要可能丢失细节，完整原文仍可查看。

所有摘要成功且估算用量确实降低后才替换上下文。摘要为空、工具响应、模型失败、单条历史
消息过大或压缩后仍超限时明确失败，不发送已知超限的任务请求。无可压缩历史时手动操作
无副作用。运行中压缩随完整轮次保存，失败仍恢复 beginTurn 的稳定快照。

离线 Context Eval 验证长历史分批压缩、决定与否定条件、未决问题、工具配对、摘要注入信任
边界、供应商超限重试、失败回滚和 Session 隔离；脚本化响应不等于真实摘要质量评测。

`/compact` 由两个前端路由到共享的轮次间操作，不追加用户消息，不启动普通 Agent Loop。
运行或压缩中禁用重复提交和 Session 切换。全屏输入区底部实时显示估算的已用 Token、
500k 窗口和百分比；模型响应及工具结果加入历史后触发刷新，切换 Session 后重新读取。
非 TTY 在每次输入提示前显示当前用量。手动压缩失败不会把原等待/中断状态改为运行失败。

Context 模块必须保持：

- 按来源和优先级构建上下文；
- 在确定性预算触发时选择 Compaction 策略；
- 保证 Tool Use 与 Tool Result 成对保留；
- 保留当前 Spec 版本、Decision、OpenQuestion、审批和暂停状态；
- 记录压缩前后摘要来源、模型、Token 与不可恢复信息。

简单截断、确定性摘要和模型摘要属于同一接口下的不同 Adapter；增加策略前必须用长会话 Eval
证明需要，不能让 Compaction 改写结构化 Spec 事实。

### Skill Loader 的未来接入方式

当前 MVP 尚未实现 Skill Loading。引入后放在 `runtime/skills/`，负责发现、校验、版本记录和
按需加载 Skill Definition；它不是具体用户能力，也不能直接执行任意代码。

加载结果必须按贡献类型进入现有受控路径：

- instructions 交给 Context 模块按优先级注入；
- tools 转换为 Tool 契约并进入统一 Registry 与 Executor；
- hooks 只能注册宿主允许的事件和权限；
- metadata、来源和版本写入 Session/Audit。

Skill Loader 不得扩大用户授权、绕过 Policy，或把远程 Skill 内容提升为系统指令。首次实现时
必须覆盖恶意 Skill、版本冲突、加载失败、重复加载和卸载恢复 Eval。

## Hook

- Observer Hook 只能记录；Validator/Interceptor Hook 才能阻止行动。
- Hook 执行顺序必须确定且可测试；短路语义需要文档化。
- Hook 失败默认 fail closed 还是 fail open 必须按事件声明，安全 Hook 必须 fail closed。
- Hook 不得静默改写工具参数；若允许改写，必须保存原值、改写值和理由。
- 第三方 Skill 注册的 Hook 权限不得高于该 Skill 的信任等级。

## 模型和复杂度

- 先用能力较强模型建立质量基线，再通过 Eval 判断是否可替换成更便宜模型。
- 模型升级、系统提示变化和推理参数变化都视为行为变更，必须运行 Agent Eval。
- 多 Agent 仅用于任务可独立分解、需要隔离权限或 Eval 证明优于单 Agent 的场景。
- 调度者必须负责合并冲突、预算和最终验收，不能假定子 Agent 输出正确。

## 依据

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [OpenAI: A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)

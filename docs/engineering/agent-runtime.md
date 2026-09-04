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

## 上下文构建

上下文必须标注来源并保持优先级边界：系统策略、用户指令、已确认 Spec、项目事实、检索内容、
工具结果、记忆。外部内容永远是数据，不得升级成系统指令。

- 只注入当前决策所需内容，避免把整个仓库和历史永久塞入上下文。
- 摘要必须保留来源引用、未决问题和关键否定条件。
- Context compaction 前后必须保持 Spec、审批和未完成工具调用的一致性。
- Prompt 与 Skill 必须版本化；一次运行应记录实际使用的版本和模型参数。

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

# 架构规范

## 目标

SpecPilot 是 specification-aware Agent Runtime。它允许模型动态调查和选择工具，同时用
确定性代码约束权限、状态、生命周期和验收。架构必须保持可理解，不能为了展示技术栈
引入不必要框架。

## 分层与依赖方向

```text
CLI / API
    ↓
Application / Agent Runtime
    ↓
Domain: Spec、Decision、Session、Policy decision
    ↓
Ports: Model、Tool、Store、Approval、Event sink
    ↓
Adapters: Anthropic、Filesystem、MCP、SQLite、Web
```

- 上层可以依赖下层公开契约；领域层不得导入 CLI、数据库、具体模型 SDK 或终端交互。
- CLI 只负责输入输出和命令路由，不得实现权限判断或 Agent 推理。
- Agent Loop 负责生命周期编排，不得直接实现具体工具。
- Tool 负责单一外部能力，不得自行修改全局会话或绕过 Policy。
- Policy 只做确定性裁决；交互由 Approval/HITL 适配器完成。
- Hook 用于横切扩展，不能成为隐藏业务流程或秘密依赖注入容器。

## 模块设计

- 一个模块围绕一个稳定概念，而不是机械地“一类一文件”。
- 公共接口必须小于内部实现；默认保持符号私有，仅导出真实稳定的 API。
- 跨层调用优先使用 `Protocol` 或小接口，不建立双向导入。
- 依赖在组合根统一装配；业务模块不得创建难以替换的全局网络客户端。
- 数据模型与 I/O 分开；Pydantic 主要用于系统边界和持久化契约。

## 确定性边界

以下内容必须由普通代码实现，不能仅写进系统提示：

- 输入 Schema 校验、路径边界、权限和审批要求；
- 状态转换、版本冲突、幂等键、超时、重试上限；
- Token/费用/轮次预算和停止条件；
- 密钥脱敏、审计事件、持久化完整性；
- “完成”的机器可验证条件。

模型适合负责：不确定性识别、信息搜索策略、候选问题、计划和自然语言解释。模型建议必须
经过确定性边界后才能产生外部副作用。

## 复杂度准入

新增框架、多 Agent、向量数据库或分布式队列前，必须记录：

1. 当前简单实现解决不了的具体场景；
2. 可量化基线与期望提升；
3. 新失败模式、运维成本和回退方案；
4. 最小实验及结果。

跨越多个模块、改变长期边界或难以逆转的决定应该写 ADR，至少包含 Context、Decision、
Alternatives、Consequences 和 Status。

## 变更检查表

- 依赖方向是否仍单向？
- 是否把确定性规则错误地交给模型？
- 是否新增隐藏副作用或模块级网络调用？
- 是否能用更小接口、更少模块完成？
- 是否为失败、取消和恢复设计了明确路径？

## 依据

Anthropic 建议从简单、可组合模式开始，并指出框架可能遮蔽 Prompt 和响应、增加调试难度：
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)。

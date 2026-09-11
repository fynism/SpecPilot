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

## Python 包组织

仓库采用“功能优先、机制与外部适配器显式分离”的模块化单体结构，不使用全局纯类型分层，
也不把 MVC 强行套在 Agent Runtime 上。当前包的职责如下：

```text
specpilot/
├── cli.py、config.py          # 入口与配置
├── runtime/                   # Agent Loop、Hook、供应商无关模型接口
├── tooling/                   # Tool 契约、Registry、Executor、默认工具目录
├── capabilities/              # 用户可感知的内置能力
│   ├── repository/            # 只读仓库调查
│   ├── clarification/         # Clarification HITL
│   └── spec/                  # Specification 生命周期
├── integrations/              # Anthropic 等外部 SDK 或协议适配器
└── evaluation/                # Eval 数据模型与评分
```

分类规则必须按以下顺序应用：

1. 用户可感知、可以独立描述和验收的能力放入 `capabilities/<name>/`；具体 Tool 也跟随
   所属能力，不集中堆放到一个按类型划分的目录。
2. Agent 生命周期中跨能力复用的编排机制放入 `runtime/`，例如 Loop、Hook、未来的
   Session 与 Context 管理；不得包含具体业务能力实现。
3. 所有 Tool 共同使用的契约与执行机制放入 `tooling/`；具体仓库、Spec 或澄清 Tool
   不属于这里。
4. 第三方 SDK、远程协议、数据库和终端等具体适配器放入 `integrations/<provider>/`，
   并在进入系统时转换为内部模型。
5. 只有被多个能力真实复用且语义稳定的实现才提升为共享模块；不能以“将来可能复用”为由
   提前抽象。

顶层按功能和运行角色分类，功能模块内部再按 `models.py`、`store.py`、`operations.py`、
`tool.py` 等实现职责拆分。小模块不必机械补齐全部文件；只有代码量或独立变化原因出现后才
拆分，禁止创建尚未实现的空目录和占位模块。

### 依赖方向

目标依赖方向为：

```text
CLI / composition root
    ├── Runtime
    ├── Tooling
    ├── Capabilities
    └── Integrations

Runtime       → 内部接口与 Tooling 接口
Capabilities  → Tooling 契约、同一能力内的领域实现
Integrations  → Runtime 或 Tooling 定义的接口
Evaluation    → 公开接口和受控测试数据
```

- `capabilities/` 之间不得通过彼此的内部文件建立隐式耦合；需要协作时通过稳定接口或由
  组合根装配。
- `runtime/` 不得依赖某个能力的内部实现来决定业务规则。
- `integrations/` 可以依赖第三方库，领域模型和 Tool 契约不得反向依赖具体 SDK。
- `tooling/catalog.py` 当前集中装配内置工具。MVP 的模块级依赖仍在 `runtime/agent.py`
  创建；当出现第二个前端、模型适配器或运行模式时，应提取 `bootstrap.py` 作为唯一组合根，
  而不是现在创建无实现的占位文件。

### 新模块接入实践

新增用户能力时：

1. 在 `capabilities/<name>/` 中集中模型、操作和外部行为，优先保持一个较深的公开接口；
2. Tool 输入继承 `tooling.contracts.ToolInput`，处理函数只实现该能力本身；
3. 在 `tooling/catalog.py` 中完成默认注册，仍由统一 Executor、Policy 和 Hook 执行；
4. 添加能力单元测试、Tool 契约测试；若改变 Agent 选择路径，同时添加 Eval。

新增 Agent 基础模块时：

1. 先证明它影响多个能力或 Agent 生命周期，而不是某一能力的内部实现；
2. 在 `runtime/<name>/` 建立小接口，由 Agent Loop 调用接口而不理解具体策略；
3. 把配置与具体实现留在组合根，测试通过 Fake Adapter 替换；
4. 对停止、失败、恢复、预算和状态一致性增加确定性测试。

新增外部系统时：

1. 在 `integrations/<provider>/` 实现现有接口，并尽早把外部数据转换为内部类型；
2. 凭据、重试、超时和协议错误只停留在适配器与配置层；
3. 不允许外部适配器绕过 Tool Executor、Policy、Hook 或状态机；
4. 使用契约测试验证 Adapter，默认测试不得连接真实外部系统。

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
- 新代码属于用户能力、运行时机制、共享 Tooling 还是外部适配器，放置理由是否唯一？
- 是否为了未来设想创建了尚无第二个调用方的浅接口或空模块？

## 依据

Anthropic 建议从简单、可组合模式开始，并指出框架可能遮蔽 Prompt 和响应、增加调试难度：
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)。

# Spec 与需求澄清规范

## Spec 的定位

Spec 回答“系统做成什么样才算正确”，Plan 回答“基于当前仓库如何实现”。更换实现技术后仍然
成立的内容属于 Spec；依赖文件、框架、数据库和执行顺序的内容属于 Plan。

Markdown 只用于阅读。结构化 Spec 才是事实源，至少包含：

- Goal：用户目标及成功结果；
- Scope：明确包含与排除内容；
- Requirement：可验证的行为或约束；
- Decision：已确认选择、决策者、时间和理由；
- Assumption：暂定假设、来源、置信度、影响和失效条件；
- OpenQuestion：尚未解决的问题及阻塞范围；
- AcceptanceCriterion：可观察的完成条件；
- Evidence：仓库、文档、用户回答、测试或运行结果；
- TraceLink：需求、决策、计划、代码和测试的关联。

所有实体使用稳定 ID。更新实体而不是重写历史；重大语义变化生成新版本并保留变更理由。

## 澄清策略

Agent 发现不确定性后按以下顺序处理：

1. 判断该问题能否从用户输入、仓库、文档或现有 Decision 得到答案；
2. 能调查则先调查，并保存证据；
3. 低影响且可逆时可以记录为显式 Assumption；
4. 高影响、低置信度、不可逆、安全/数据相关或会改变公开契约时必须询问用户；
5. 多个问题应按信息增益排序，只询问会改变方案的问题。

不得询问通过廉价仓库调查即可回答的问题，也不得把用户没有确认的候选选项写成 Decision。
问题必须说明为什么要问、可选项及主要后果；避免一次堆砌大量问题。

## 状态建议

```text
draft → clarifying → ready_for_approval → approved
  ↑           ↓              ↓              ↓
  └──── revised ←────────────┴──── implementation_feedback
```

- 存在阻塞性 OpenQuestion 时不得进入 `approved`。
- `approved` 只表示需求契约已确认，不表示实现已完成或获得危险操作权限。
- 实现发现新业务约束时回到 `clarifying/revised`，不得由 Plan 静默修改需求。
- 非语义性排版或证据补充可以不撤销批准，但必须记录版本变化。

## Acceptance 与 BDD

- 行为场景优先使用 Given/When/Then，覆盖主路径、边界、错误和权限路径。
- 性能、安全、兼容性、迁移等非功能约束使用可测量指标表达，不强行写成 BDD。
- 每条 Requirement 至少关联一个验收方法；无法自动化时明确人工验收步骤和责任人。
- 测试通过只是 Evidence，若测试本身没有覆盖 Spec，不代表 Requirement 已验证。

## Spec 与 Plan 的衔接

- Plan 必须引用 Requirement/Decision/Acceptance ID。
- Plan 可以提出技术风险和新问题，但不能把技术偏好提升为用户需求。
- 代码变更和测试最终关联到 Acceptance ID，形成 `需求 → 决策 → 计划 → 代码 → 证据`。
- Spec 与实现冲突时，先判断是实现缺陷还是需求变化；需求变化必须经过重新确认。

## 质量检查表

- 是否写清楚“不做什么”？
- 每条关键结论能否追溯到用户、仓库证据或显式假设？
- 是否存在主观词，如“快速、友好、合理”，但没有可观察标准？
- 边界、失败、权限、迁移和兼容场景是否明确？
- 是否把技术实现细节错误地固化成需求？
- 用户是否只被询问了真正影响结果的问题？

## 依据

OpenAI 的 Eval 指南将“先描述期望行为，再用测试输入执行并分析结果”类比为 BDD：
[Working with evals](https://developers.openai.com/api/docs/guides/evals)。

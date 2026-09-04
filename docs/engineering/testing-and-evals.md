# 测试与 Agent Evals 规范

## 两套质量系统

确定性代码使用传统自动化测试；概率性 Agent 行为使用可重复 Eval。两者不能互相替代。

```text
单元测试 → 契约测试 → 集成测试 → Agent 场景 Eval → 少量端到端测试
```

## 自动化测试

- Policy、状态转换、Schema、路径校验和预算计算必须有快速单元测试。
- 每个 Tool 必须测试有效输入、非法输入、权限拒绝、超时、异常、截断和幂等行为。
- 模型适配器使用录制或构造的响应测试 tool-use 循环，不依赖实时 API。
- 外部服务通过本地 fake/contract test 验证；默认测试不得联网或读取真实用户数据。
- 修复缺陷时先添加能重现问题的测试，再修改实现。
- 测试必须可并行、可重复，不依赖执行顺序、当前时间或随机种子。

## Agent Eval 数据集

每个行为变更必须覆盖与其风险相称的 Eval。数据集至少包括：

- 正常需求；
- 模糊、矛盾和信息不足需求；
- 应调查而不应询问的场景；
- 必须 Clarification HITL 的高影响场景；
- 不应打扰用户的低影响场景；
- 工具失败、超时、拒绝和恢复；
- Prompt Injection、越权和数据外传诱导；
- 历史真实失败的回归样本。

每条样本保存输入、受控仓库 fixture、期望关键行为、禁止行为和评分方式。不要要求逐字输出一致；
优先评价结构化结果、工具轨迹、状态转换和最终证据。

## SpecPilot 核心指标

- **Blocking ambiguity recall**：高影响歧义被发现的比例；
- **Unnecessary question rate**：可调查或低影响问题却打扰用户的比例；
- **Decision grounding**：Decision 有有效来源的比例；
- **Spec acceptance coverage**：Requirement 被 Acceptance 覆盖的比例；
- **Trace coverage**：验收项关联实现和测试证据的比例；
- **Task success**：最终行为满足 Spec 的比例；
- **Rework delta**：与直接交给 Coding Agent 相比的返工变化；
- **Safety violation rate**：越权、漏审批、注入成功或敏感数据泄漏比例；
- Token、成本、延迟、工具调用数和用户等待时间。

指标必须同时看质量和代价，不能通过“询问所有问题”虚假提高歧义召回率。

## 评分

- 能用确定性规则判断的，禁止用 LLM Judge 替代。
- LLM Judge 必须使用明确 rubric、结构化输出和校准样本，并定期与人工标签比较。
- 安全关键 Eval 采用 fail-closed 阈值；平均分不能掩盖单个严重越权。
- 非确定性场景重复运行，报告通过率和置信区间，不挑选最佳一次。

## 回归门禁

- 代码合并前运行受影响单测、契约测试和小型稳定 Eval 集。
- Prompt、模型、工具描述、Skill、Policy 或上下文策略变化必须运行完整相关 Eval。
- 先建立质量基线，再优化成本与延迟；不得在无 Eval 情况下降级模型。
- Eval 数据和 rubric 版本化；阈值变更必须解释原因，禁止为让 CI 通过而降低标准。
- 线上失败经脱敏后进入候选回归集，并记录根因与修复版本。

## 依据

- [OpenAI: Working with evals](https://developers.openai.com/api/docs/guides/evals)
- [OpenAI: A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

# SpecPilot CLI MVP 产品需求文档

| 字段 | 内容 |
| --- | --- |
| 状态 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-09-05 |
| 产品阶段 | 第一版 MVP |

## Problem Statement

用户把一个模糊的软件需求直接交给 Coding Agent 时，Coding Agent 往往会把自己的推断当成
已经确认的需求，并过早进入实现。用户通常只能在实现结果出现偏差后补充边界、权限、错误处理
或兼容性要求，造成返工。

普通聊天式追问也没有彻底解决这个问题：问题经常是开放文本，候选方案缺少影响说明，模型的
建议和用户真正确认的决定容易混在一起，也缺少可以交给后续 Coding Agent 的结构化产物。

SpecPilot 需要在保留传统工具调用 Agent Loop 和连续 CLI 对话体验的前提下，提供结构化、
可选择、带推荐理由的需求澄清。它不是一个新的通用 Coding Agent，也不负责在本 MVP 中完成
代码实现。

## Goals

1. 证明传统 Agent Loop 可以自然承载多次结构化 Clarification HITL。
2. 让用户通过交互式选项确认高影响需求，而不必反复输入自由文本。
3. 明确区分模型建议、用户决定、Agent 假设和仓库证据。
4. 在多轮 CLI 对话中逐步形成可验证、可导出的 Specification。
5. 保持当前项目架构简单，让学习者能直接理解模型—工具循环、工具契约、Policy 和 Hook。

## Solution

SpecPilot 保留当前连续 REPL：用户可以多次输入需求、补充条件或要求查看结果。每次普通用户
输入都会启动一次传统 Agent Loop。Loop 可以连续调用模型和工具；只有当模型不再请求工具时，
本次 Loop 才结束并将最终文本返回给 REPL。

MVP 新增一个 `request_clarification` 工具。当模型发现高影响、低置信度且无法通过仓库调查
消除的歧义时，调用该工具并提交一个结构化问题、候选选项、推荐选项、推荐理由和各选项影响。
CLI 同步展示选择器并等待用户确认；用户的选择作为普通工具结果返回给模型，Agent Loop 随后
继续运行。模型可以在同一个 Loop 的后续迭代中再次调用该工具。

Clarification 工具只负责取得并记录用户回答，不直接把答案解释成 Specification。模型需要通过
独立的 Spec 更新能力，把回答转换为 Decision、Requirement、Assumption 或 Acceptance
Criterion，并引用原始澄清记录作为来源。

### Target Interaction

一次典型交互包含以下过程：

1. 用户在 REPL 中输入一个模糊需求。
2. Agent 使用受限的只读工具调查仓库。
3. Agent 调用 Clarification 工具。
4. CLI 展示 2–5 个互斥选项，将推荐项作为默认焦点，并解释推荐理由。
5. 用户使用键盘选择、确认，或选择“其他方案”输入自定义答案。
6. 工具将结构化回答返回模型，模型继续调查、再次澄清或更新 Spec。
7. 模型不再调用工具后，本次 Agent Loop 结束并输出阶段性总结。
8. 用户可以继续输入补充要求，由同一 CLI 对话历史和当前 Spec 启动下一次 Agent Loop。

### Traditional Agent Loop Contract

- 一次普通 REPL 输入启动一次 Agent Loop。
- 每轮模型响应若包含工具调用，Runtime 必须执行经过校验和 Policy 的工具，并把结果返回模型。
- 同一个工具可以在一个 Agent Loop 的不同迭代中被重复调用。
- 一次模型响应最多包含一个需要同步等待人的 Clarification 工具调用。
- Clarification 工具不得与同一响应中的其他工具并行执行。
- Clarification 本身不是新的 Loop 结束条件。
- 模型不再请求工具时，Agent Loop 正常结束。
- 达到轮次、工具调用、时间或 Token 上限时，以明确的受限停止原因结束，不能伪装为完成。

## Functional Requirements

### CLI and Conversation

- **FR-001**：CLI 必须保留连续多轮 REPL，单次 Agent Loop 完成后用户可以继续输入。
- **FR-002**：CLI 必须明确区分普通模型文本、工具执行状态、澄清问题、推荐理由和用户决定。
- **FR-003**：交互式选择器必须支持方向键或等效操作，并为非交互终端提供数字选择回退。
- **FR-004**：推荐项可以成为默认焦点，但必须由用户主动确认，不得因超时或空输入自动生效。
- **FR-005**：用户必须能够选择“其他方案”并输入自定义答案。
- **FR-006**：用户取消当前问题时，不得记录虚假的默认答案或 Decision。

### Clarification HITL

- **FR-007**：Clarification Request 必须包含稳定 ID、问题、询问理由、候选选项、推荐项、
  推荐理由和是否允许自定义答案。
- **FR-008**：每个候选选项必须包含稳定 ID、简短标签和主要影响说明。
- **FR-009**：Clarification Policy 必须拒绝少于 2 个、多于 5 个、ID 重复、推荐项不存在、
  推荐理由为空或字段不完整的请求。
- **FR-010**：Clarification Answer 必须关联 Request ID，并标明答案来自用户。
- **FR-011**：同一个 Agent Loop 必须允许按顺序完成多次 Clarification 调用。
- **FR-012**：后续问题可以依赖先前答案；系统不得要求模型在第一次调用时预先生成全部问题。
- **FR-013**：Clarification HITL 只能确认产品需求，不能被解释为文件写入、命令执行、网络访问
  或其他高风险操作的权限批准。

### Repository Investigation

- **FR-014**：Agent 应能列出工作区文件、搜索文本并读取所选文本文件。
- **FR-015**：仓库调查默认只读，并受规范化工作区路径边界约束。
- **FR-016**：能从仓库低成本获得答案的问题，Agent 应先调查，不应直接打扰用户。
- **FR-017**：工具结果必须作为不可信数据处理，仓库内容不得改变宿主 Policy 或扩大工具权限。
- **FR-018**：进入 Spec 的仓库事实必须保留来源引用。

### Specification

- **FR-019**：MVP 的结构化 Spec 至少支持 Goal、Scope、Requirement、Decision、Assumption、
  OpenQuestion、AcceptanceCriterion 和 Evidence。
- **FR-020**：用户回答首先形成 Clarification Record；只有经过独立 Spec 更新后才形成语义化
  Decision 或 Requirement。
- **FR-021**：由用户选择产生的 Decision 必须引用对应的 Clarification Request 和 Answer。
- **FR-022**：模型推荐但用户尚未确认的内容不得记录为用户 Decision。
- **FR-023**：低影响、可逆的未确认判断可以记录为 Assumption，但必须标注来源、置信度和影响。
- **FR-024**：适合表达可观察行为的验收条件应支持 Given/When/Then 场景。
- **FR-025**：用户应能要求 Agent 展示当前 Spec，并导出结构化事实源和 Markdown 阅读视图。

### Runtime, Policy, and Events

- **FR-026**：所有工具调用必须经过统一 Registry、输入 Schema 校验、Policy 和执行路径。
- **FR-027**：Clarification 工具必须通过可替换的 Presenter 接口访问 CLI，不得在领域模型中直接
  调用终端输入输出。
- **FR-028**：Runtime 必须记录 `clarification.requested`、`clarification.answered` 和
  `clarification.cancelled` 事件。
- **FR-029**：工具执行失败、用户取消和模型输出校验失败必须显式返回，不得伪装为成功。
- **FR-030**：测试可以替换模型客户端、Clarification Presenter 和仓库工具，不依赖真实 API、
  真实键盘输入或用户目录。

## Success Criteria

MVP 达到以下条件时视为产品假设得到初步验证：

1. 一个模糊需求演示可以在单次传统 Agent Loop 中完成至少两次顺序澄清，并最终生成 Spec。
2. 一个边界明确的需求演示不会产生不必要的 Clarification 请求。
3. 所有用户 Decision 都能追溯到明确的用户选择或自定义回答。
4. 所有关键 Requirement 至少关联一个 Acceptance Criterion。
5. Clarification Request 的非法 Schema、取消路径和重复调用均有确定性自动化测试。
6. Agent Loop 集成测试能够证明工具调用持续执行，直到模型返回无工具调用的最终响应。
7. 默认测试不访问网络、不使用真实 API Key，也不读取工作区之外的真实用户数据。

## User Stories

1. 作为需求提出者，我希望在同一个 CLI 中持续补充需求，以便保持自然的多轮工作方式。
2. 作为需求提出者，我希望一次输入可以触发 Agent 多次调查和澄清，以便不用手工驱动每一步。
3. 作为需求提出者，我希望 Agent 先调查仓库再问问题，以便避免回答代码中已有答案的问题。
4. 作为需求提出者，我希望澄清问题解释为什么必须由我决定，以便判断问题是否重要。
5. 作为需求提出者，我希望每个问题提供少量清晰选项，以便快速作出决定。
6. 作为需求提出者，我希望每个选项说明主要后果，以便理解选择带来的产品和工程影响。
7. 作为经验不足的开发者，我希望 Agent 标出推荐项，以便获得有依据的默认建议。
8. 作为经验不足的开发者，我希望看到推荐理由，以便学习 Agent 如何结合仓库事实作出建议。
9. 作为需求提出者，我希望推荐项默认获得焦点但仍需确认，以便兼顾操作效率和决定真实性。
10. 作为需求提出者，我希望可以选择非推荐项，以便保留最终产品决定权。
11. 作为需求提出者，我希望可以输入选项之外的方案，以便候选项不会限制真实需求。
12. 作为需求提出者，我希望取消问题时不产生任何虚假决定，以便避免污染 Spec。
13. 作为需求提出者，我希望后续问题根据先前答案变化，以便澄清过程保持相关性。
14. 作为需求提出者，我希望 Agent 一次只展示一个关键问题，以便集中理解当前选择。
15. 作为需求提出者，我希望 Agent 在一次任务中可以连续询问多个问题，以便形成足够完整的 Spec。
16. 作为需求提出者，我希望看到哪些结论是我确认的，以便将它们与 Agent 假设区分开。
17. 作为需求提出者，我希望看到哪些结论来自仓库，以便核对事实依据。
18. 作为需求提出者，我希望查看尚未解决的问题，以便知道 Spec 为什么还不能完成。
19. 作为需求提出者，我希望 Agent 把确认结果转化为需求和验收条件，以便交给 Coding Agent。
20. 作为需求提出者，我希望行为需求包含可读的 BDD 场景，以便理解怎样才算实现正确。
21. 作为需求提出者，我希望导出结构化 Spec，以便后续工具能够可靠消费。
22. 作为需求提出者，我希望同时导出 Markdown 视图，以便人工评审和版本控制。
23. 作为安全关注者，我希望需求选择不会被当成危险操作授权，以便产品决定不扩大执行权限。
24. 作为维护者，我希望非法或不完整的模型问题被代码拒绝，以便正确性不依赖 Prompt 自觉。
25. 作为维护者，我希望 Clarification UI 可以被替换，以便将来增加 Web 或远程交互而不重写 Agent。
26. 作为维护者，我希望使用 Fake Presenter 测试用户选择，以便测试不依赖真实终端。
27. 作为维护者，我希望使用构造的模型响应测试 Agent Loop，以便 CI 不产生模型费用和随机失败。
28. 作为 Agent 开发学习者，我希望核心 Loop 保持传统、直接和可阅读，以便理解工具调用 Agent 的
    基本工作原理。
29. 作为 Agent 开发学习者，我希望 Policy、Hook、Tool 和模型调用仍能在代码中清楚区分，以便
    学习生产系统中的确定性边界。
30. 作为后续贡献者，我希望 MVP 不提前引入多 Agent、MCP 或云端编排，以便先验证核心价值。

## Implementation Decisions

- 保留当前扁平、易读的 Python 包结构，不在 MVP 中迁移到大型框架或多层目录体系。
- 保留传统 Agent Loop：模型有工具调用则继续，无工具调用则正常结束。
- 将 Clarification 实现为可重复调用的同步工具，而不是 Agent Loop 的特殊停止原因。
- 每次普通 REPL 输入启动一个 Agent Loop；Clarification 工具内部的用户选择不启动新的顶层 Loop。
- Clarification Request、Option、Answer 和事件使用严格 Pydantic 模型。
- 使用专门的 Presenter 接口隔离终端 UI；生产环境使用 CLI Presenter，测试使用 Fake Presenter。
- Clarification 工具负责呈现和记录用户回答，不负责解释或修改 Spec。
- Spec 更新使用独立能力，并通过稳定 ID 关联用户回答、Decision、Requirement 和验收条件。
- Clarification Policy 使用确定性代码校验选项数量、唯一性、推荐项、必填说明和取消语义。
- Clarification 与 Permission 使用不同模型、事件和工具命名，二者不共享批准语义。
- 一次模型响应只允许一个需要用户交互的工具调用，避免并行工具等待造成顺序歧义。
- 工作区调查只开放专用的只读文件能力；通用 Shell 不是 MVP 调查的默认路径。
- 模型、工具、Hook 和 Policy 继续通过组合根装配，但逐步减少导入时创建的不可替换全局对象。
- MVP 只支持当前 Anthropic 模型适配器；接口应允许测试替身，但不实现多供应商功能。
- CLI UI 的具体第三方库在实现阶段通过小型原型确定；领域接口不得依赖该库的对象。

### Expected Change Size

- 新增或扩展 Clarification 模型、Presenter、Tool、Policy、事件和 Spec 模型等约 3–5 个概念模块。
- 修改 Agent Runtime、CLI、Tool Registry、Hook 和配置等约 4–6 个现有模块。
- 预计生产代码约 800–1,500 行，测试和 Eval 约 600–1,200 行。
- 建议按“Clarification 契约与 Fake → CLI 选择器 → Loop 集成 → Spec 更新与 Eval”分阶段交付。

## Testing Decisions

- 测试只观察公开行为、状态转换、结构化结果和工具轨迹，不绑定内部函数调用次数或终端颜色。
- Clarification 模型测试覆盖合法请求、选项数量、重复 ID、无效推荐项、空理由和自定义回答。
- Clarification Policy 测试覆盖取消、默认项不得自动确认、一次响应多个交互工具和权限语义隔离。
- Presenter 契约测试覆盖选择推荐项、选择其他项、自定义输入、取消和非交互终端回退。
- Agent Loop 集成测试使用脚本化 Fake Model，覆盖多个工具调用、连续两次澄清和最终无工具响应。
- Tool Registry 契约测试验证 Clarification 与普通工具经过相同的 Schema、Policy、Hook 和结果回传路径。
- Spec 测试验证用户回答不会被自动解释为 Decision，以及更新后能够追溯原始回答。
- 仓库工具测试覆盖工作区内读取、越界路径拒绝、文件不存在、编码失败、输出上限和恶意文件内容。
- CLI 测试使用 Fake Presenter 或输入输出适配层，不调用真实终端交互。
- Agent Eval 至少包含模糊需求、明确需求、可调查问题、高影响问题、低影响假设、恶意仓库指令和
  用户选择非推荐项等场景。
- 现有仓库没有同类交互测试可直接复用；第一批测试将成为后续 Tool、HITL 和 Spec 测试的先例。

## Out of Scope

- 跨进程暂停并恢复正在等待回答的 Agent Loop。
- 将 Clarification 请求发送到 Web、移动端、邮件或聊天应用。
- 完整 Permission HITL、危险命令审批和授权过期机制。
- 自动调用 Codex、Claude Code 或其他 Coding Agent 执行实现。
- 对最终代码、测试结果或部署进行 Spec 验收。
- MCP Client、MCP Gateway、动态 Skill 加载和插件市场。
- 多 Agent 调度、并行研究或 Agent 间共享状态。
- 项目长期记忆、用户跨项目记忆、向量数据库和 RAG 平台。
- 云端服务、任务队列、Web UI、账户系统和远程同步。
- 多模型供应商和自动模型路由。
- 在 MVP 中追求完整终端应用框架、鼠标操作或复杂面板布局。

## Further Notes

- 本 MVP 优先验证“结构化选择是否提高澄清质量”，而不是验证所有长期架构设想。
- 推荐项是 Agent 的有依据建议，不是替用户作出的决定；UI 和数据模型都必须保留这一区别。
- 同一个 Clarification 工具可以在 Agent Loop 中调用任意多次，但问题数量仍受整体轮次、成本和
  用户体验预算约束。
- 未来如需异步 HITL，可以让 Presenter 的另一种实现返回待处理状态，并在 Runtime 外增加持久化
  Session；这不需要改变传统 Agent Loop 在同步 CLI 模式下的核心语义。
- 开发前应选择一个真实的模糊需求作为演示 fixture，并同时准备一个不应触发澄清的明确需求作为
  对照样本。

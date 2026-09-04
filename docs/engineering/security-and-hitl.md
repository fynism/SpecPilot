# 安全与 HITL 规范

## 威胁模型

至少考虑以下信任边界：用户输入、仓库文件、网页/文档、模型输出、Skill、MCP 服务器、工具结果、
持久化记忆、云端执行器和日志系统。除宿主策略与用户当轮明确授权外，进入系统的自然语言均
可能包含恶意或误导性指令。

Prompt Injection 无法仅靠更强系统提示彻底解决。安全必须依靠权限隔离、结构化数据流、最小
权限、审批、沙箱、输出验证和对抗测试共同降低影响。

## 强制原则

- 权限、身份、访问控制、路径边界和危险动作判断必须由确定性代码执行。
- 模型不能批准自己的行动，也不能根据工具返回内容扩大权限。
- 外部内容只能作为数据进入低权限上下文，不得拼入系统/开发者指令。
- 只向模型和工具提供完成当前任务所需的最少数据、最少工具和最短授权时间。
- 任何发送数据到外部系统的动作都必须明确数据、目的地和目的。
- 密钥不得进入 Prompt、Spec、记忆、异常、日志或模型可见工具结果。

## 两类 HITL

### Permission HITL

回答“Agent 是否被允许执行这个动作”。触发依据是副作用、数据敏感度、不可逆性、外部传播和
授权范围。审批界面必须展示真实工具、关键参数、风险、数据去向和可选替代方案。

### Clarification HITL

回答“产品需求应该是什么”。触发依据是需求不确定性的影响与置信度。它产生 Decision 或
Requirement，不产生系统权限；用户选择业务行为不等于授权执行危险命令。

两者必须使用不同的数据模型、状态和审计事件。

## 风险分级

| 等级 | 示例 | 默认处理 |
| --- | --- | --- |
| R0 | 工作区内列目录、读取公开源码 | 自动允许并记录 |
| R1 | 执行测试、创建可恢复临时文件 | 按会话策略允许 |
| R2 | 修改源码、安装依赖、访问外部网络 | 需要明确授权或预先配置策略 |
| R3 | 删除/覆盖数据、发布、发消息、使用敏感数据 | 每次操作前审批 |
| R4 | 破坏系统、安全绕过、越权、泄露密钥 | 永久拒绝 |

风险不仅由工具名决定，还取决于参数、目标、数据和上下文。审批必须发生在动作即将执行时；
参数变化后旧批准失效。

## Approval 状态

审批请求至少包含：`request_id`、会话、原始 action、理由、风险等级、scope、过期时间和
decision。批准应绑定规范化参数摘要，不能使用模糊的“本次全部允许”。拒绝结果返回 Agent，
允许它选择安全替代路径，但不得反复诱导用户批准。

## Prompt 与输出安全

- 在不可信文本和宿主指令之间使用明确结构边界。
- 跨节点或跨 Agent 优先传递经过 Schema 校验的字段，而不是整段自由文本。
- 对模型生成的命令、路径、URL、SQL 和代码按其目标解释器再次验证。
- 不把隐藏推理作为审计依据；记录行动理由、输入来源和决策结果即可。
- 对间接注入、混淆文本、恶意仓库说明、工具投毒和数据外传编写安全 Eval。

## 安全变更检查表

- 新能力扩大了哪些读取、写入、网络或身份权限？
- 恶意仓库/MCP 返回能否影响高权限工具调用？
- 拒绝、超时和取消是否 fail closed？
- 审批是否绑定具体动作，并可被审计和撤销？
- 日志、错误和测试样本是否可能包含敏感信息？

## 依据

- [OpenAI: Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)
- [OWASP LLM01: Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [MCP specification: Security and Trust & Safety](https://modelcontextprotocol.io/specification/2025-11-25)
- [NIST AI RMF Generative AI Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence)

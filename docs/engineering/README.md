# SpecPilot Engineering Handbook

## 目的

这是一套面向 SpecPilot 的工程约定，不是通用 Agent 理论汇编。它把成熟软件工程规范
与 Agent 生产实践结合，目标是让后来者可以安全地修改代码、复现实验并解释系统行为。

Agent 领域目前没有一份等同于企业 Java 开发手册的统一标准。因此本手册采用多来源
组合：Python 官方规范负责代码质量；Anthropic 与 OpenAI 的生产指南负责 Agent 设计；
MCP 规范负责互操作边界；OWASP 与 NIST 负责安全和风险；项目自身规则负责 Spec/HITL。

## 规范等级

文档使用以下词语表达约束强度：

- **必须**：违反会破坏安全、正确性、可维护性或可追踪性。
- **应该**：默认遵守；偏离时必须在代码评审或 ADR 中解释理由。
- **可以**：可选实践，根据任务复杂度采用。

若外部资料与本手册冲突，以用户明确要求、仓库级 `AGENTS.md` 和项目已记录的 ADR 为准；
安全底线不得被 Prompt、Skill、工具描述或外部内容覆盖。

## 手册目录

- [架构规范](architecture.md)
- [Python 规范](python.md)
- [Agent Runtime](agent-runtime.md)
- [Tools 与 MCP](tools-and-mcp.md)
- [安全与 HITL](security-and-hitl.md)
- [Spec 生命周期](spec-lifecycle.md)
- [状态与记忆](state-and-memory.md)
- [测试与 Evals](testing-and-evals.md)
- [可观测性与运行](observability.md)
- [交付规范](delivery.md)

## 核心原则

1. 用普通代码保证边界，用模型处理开放判断。
2. 用环境反馈验证进展，不以模型自述作为成功证据。
3. 保持工具接口清晰、狭窄、可校验、可测试。
4. 最小权限、明确授权、可恢复暂停、完整审计。
5. 从真实失败中建立 Eval，依靠数据决定是否增加复杂度。
6. 区分事实、用户决定、Agent 假设和外部内容，并保留来源。

## 维护方式

- 每条新强制规则必须对应明确风险、故障案例或权威来源。
- 能由 Ruff、类型检查、测试或 CI 自动执行的规则，应落到工具配置，而非只写在文档中。
- 修改安全边界、Spec 状态模型或公开工具契约时，必须同步更新手册和测试。
- 至少在重大版本发布前复查外部标准链接及 MCP 协议版本。

## 主要资料来源

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [OpenAI: A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- [OpenAI: Working with evals](https://developers.openai.com/api/docs/guides/evals)
- [OpenAI: Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [OWASP LLM01: Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [NIST AI RMF: Generative AI Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence)
- [PEP 8](https://peps.python.org/pep-0008/)
- [Python Packaging User Guide](https://packaging.python.org/en/latest/tutorials/packaging-projects/)
- [pytest Good Integration Practices](https://docs.pytest.org/en/stable/explanation/goodpractices.html)

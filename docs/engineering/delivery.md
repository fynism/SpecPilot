# Git、依赖与交付规范

## 分支与提交

- 一个提交只表达一个逻辑变化，并在提交时可构建、可测试。
- 重构、功能、修复、格式化和依赖升级不得混在同一提交。
- 禁止提交 `.env`、密钥、真实用户数据、模型缓存、日志和临时 artifact。
- 不重写他人历史、不丢弃不属于当前任务的工作树改动。

提交信息采用 Conventional Commits：

```text
<type>(optional-scope): <中文摘要>
```

`type` 和可选 `scope` 保留 Conventional Commits 的英文机器可读格式；摘要与正文统一使用
中文，确保项目提交历史对当前协作者清晰一致。例如：

```text
docs: 添加工程手册与 Agent 开发指引
feat(spec): 增加结构化需求状态
```

常用类型：

- `feat`：用户可观察的新能力；
- `fix`：缺陷修复；
- `refactor`：不改变行为的结构调整；
- `test`：只改变测试或 Eval；
- `docs`：只改变文档；
- `chore`：工具、构建或维护；
- `perf`：有测量依据的性能改进；
- `revert`：撤销先前提交。

破坏性变更使用 `!` 或正文中的 `BREAKING CHANGE:`，并同时提供迁移说明。

## 变更与评审

提交或 PR 描述至少包含：

1. 问题和范围；
2. 关键设计决定及替代方案；
3. 用户可观察行为变化；
4. 安全、数据和兼容性影响；
5. 实际运行的测试/Eval 及结果；
6. 未验证内容、已知限制和回滚方式。

纯重构必须证明行为保持。Agent 行为变化必须附 Eval 变化或解释为什么现有 Eval 已覆盖。
对公开 Tool、Spec Schema、持久化格式或审批语义的变化必须进行兼容性评审。

## 合并门禁

在工程配置完成后，默认要求：

```text
format check → lint → type check → unit/contract tests → relevant agent evals
```

- 失败门禁不得通过跳过、降阈值或删除测试解决，除非评审明确证明规则错误。
- Flaky test 必须隔离、登记根因并限期修复；不能无限重跑直到通过。
- 文档、示例和 `.env.example` 必须与用户可见接口同步更新。

## 依赖

- 新依赖必须说明功能、许可证、维护状态、安全风险、体积和无依赖替代方案。
- 固定顶层依赖范围并提交锁文件；部署必须从锁定环境构建。
- 依赖升级独立提交，附变更说明并运行完整测试和相关 Eval。
- MCP Server、模型、Prompt 和 Skill 同样视为运行时依赖，必须记录版本。

## 版本与发布

公开接口稳定后采用 Semantic Versioning：

- MAJOR：不兼容公开接口或持久化契约；
- MINOR：向后兼容能力；
- PATCH：向后兼容修复。

在 `0.x` 阶段仍需记录破坏性变化。发布产物必须可追溯到 Git commit、依赖锁、模型配置、
Prompt/Skill 版本和通过的测试/Eval 报告。

## 回滚

- 每项有外部副作用或数据迁移的发布必须有回滚/前滚方案。
- 数据迁移先保证旧代码可读，再切换写入，最后删除兼容路径。
- 模型或 Prompt 发布支持快速回退到已知基线，但不得因此跳过上线前 Eval。

## 依据

- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [Semantic Versioning 2.0.0](https://semver.org/)
- [Python Packaging User Guide](https://packaging.python.org/en/latest/tutorials/packaging-projects/)

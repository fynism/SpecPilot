# Tools、Skills 与 MCP 规范

## Tool 契约

每个工具必须定义：

- 唯一、稳定、动词开头的名称；
- 单一职责以及“不适用场景”；
- 严格输入 Schema、字段说明、约束和示例；
- 结构化成功结果和结构化错误；
- `read`、`write`、`external_effect` 等副作用类别；
- 风险等级、所需权限、超时、输出上限和是否幂等。

工具描述是 Agent-Computer Interface，必须像公共 API 一样评审和测试。相似工具要明确边界，
避免让模型猜测差异。参数设计应让错误难以发生，而不是依赖 Prompt 提醒模型小心。

- 项目自有 Tool 的描述、参数说明、处理函数 docstring 和面向用户的交互提示必须使用简体中文；
  工具名、Schema 字段名和外部协议规定的标识符保留英文。
- Tool 中涉及用户确认、推荐默认项、权限判断、取消或结果复验的关键逻辑，必须用中文注释解释
  信任边界和不能省略该判断的原因。

## 执行规则

- 所有工具经同一 Registry、Schema 校验、Policy、Hook 和审计路径执行。
- 读工具和写工具分离；能用专用工具完成时不得使用通用 Shell。
- 文件工具必须限定根目录并在解析符号链接后再次验证边界。
- 外部副作用工具必须支持幂等键或重复调用检测。
- 设置超时、输出字节上限和明确的截断标记；大结果写入受控 artifact，只返回摘要和引用。
- 工具异常不能泄漏密钥，也不能返回模糊的“失败了”；应提供分类、可重试性和安全诊断。
- 工具输出属于不可信数据，进入模型前仍需尺寸、类型和内容边界校验。

## Shell 工具

Shell 是最后手段，不是默认文件 API。

- 默认只允许工作区内执行，并使用受限环境变量和明确工作目录。
- 高危命令使用不可审批的 deny policy；写入、删除、网络和进程操作按风险审批。
- 不以字符串黑名单作为唯一防线；应结合沙箱、路径能力、命令解析和最小权限。
- 记录命令、工作目录、退出码、耗时和输出截断信息，记录前先脱敏。

## Skill

- Skill 是版本化能力包，包含触发条件、说明、资源、工具和可选策略，不是隐藏 Workflow。
- 初始上下文只暴露名称、用途和加载成本；由 Agent 按需加载完整内容。
- Skill 内容与来源必须可审计；远程或第三方 Skill 默认不可信。
- 加载 Skill 不能扩大用户原始授权，也不能绕过宿主 Policy。
- Skill 更新视为行为变更，必须运行相关 Eval；会话记录实际加载的版本。

## MCP

- 固定并记录协议版本；升级前阅读对应版本的 changelog 和安全说明。
- 为不同服务器命名空间化工具，不能依赖服务器名称天然唯一。
- 工具描述和 annotations 默认不可信，宿主自行维护风险元数据。
- 只请求完成任务所需 scope；Token 必须绑定目标资源，禁止 token passthrough。
- 凭据不得交给模型、Prompt 或日志；本地 stdio 服务从受控环境获得凭据。
- 敏感调用展示服务器、工具、关键参数、数据去向和预期副作用后再请求批准。
- 客户端必须实现超时、取消、速率限制、结果校验和审计。

## Tool 变更检查表

- 是否真的需要新工具，还是现有工具的明确参数即可？
- 名称、描述和字段能否让不了解实现的人唯一判断用法？
- 是否列出副作用、幂等性和失败语义？
- 是否测试非法输入、超时、重复调用、大输出和权限拒绝？
- 外部返回中的指令是否被当作不可信数据？

## 依据

- [Anthropic: Prompt engineering your tools](https://www.anthropic.com/engineering/building-effective-agents#appendix-2-prompt-engineering-your-tools)
- [MCP Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

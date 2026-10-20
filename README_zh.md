# SpecPilot

[English](https://github.com/fynism/SpecPilot/blob/v0.1.1/README.md) | 简体中文

SpecPilot 帮助你在开始编码前，把软件想法梳理成清晰的需求。在项目目录中运行后，
它会调查现有仓库、提出有针对性的问题，并记录你确认的需求、范围、产品决策和验收示例。

## 安装

需要 **Node.js 22.12 或更高版本**，以及支持 Anthropic API 和工具调用的模型服务、
API Key。模型请求使用你配置的服务，可能产生 API 费用。

```sh
npm install -g @fyismus/specpilot
```

也可以不进行全局安装，直接下载并运行：

```sh
npx @fyismus/specpilot@latest
```

## 首次使用

在你希望处理的项目目录中打开终端，运行：

```sh
specpilot
```

首次交互启动时，如果缺少配置，SpecPilot 会自动打开配置向导。依次填写：

1. **API 协议**：选择 **Anthropic**。目前可以保存 OpenAI 配置，但尚不支持运行 OpenAI 协议。
2. **Base URL**：服务商提供的 HTTPS API 基础地址。保留必要的路径前缀，但不要填写完整的
   messages 接口地址、账号密码、查询参数或 URL 片段。
3. **模型 ID**：服务商提供的准确模型标识。
4. **API Key**：服务商提供的密钥。输入内容会遮蔽，支持粘贴。

保存配置不会测试连接，也不代表服务商一定兼容。API 配置跨项目复用，保存在
`~/.specpilot/config.json`（`~` 对应你的用户目录）。**API Key 以明文保存，并限制文件访问权限。**
请妥善保护该文件。

之后可以随时修改配置：

```sh
specpilot config
```

该命令保存后退出，重新运行 `specpilot` 即可使用配置。

## 开始梳理需求

先描述一个具体目标：

```text
/clarify 为这个应用增加找回密码流程
```

SpecPilot 会调查仓库并打开澄清总览。你可以回答问题、修改之前的答案，或暂缓暂时无法回答的问题。
编辑内容先保存为草稿；在总览中按 **c**，统一提交答案并进入下一轮。

按 **Enter** 编辑问题，**Tab** 切换本轮问题和全部主题，**d** 暂缓或恢复问题，**b** 返回聊天。
返回聊天不会提交草稿，也不会结束澄清。使用 `/clarify` 可以重新打开已有进度。

普通聊天用于讨论和只读仓库调查。开始或继续处理需求时，请明确使用 `/clarify <需求描述>`。
如果希望停止追问并总结已有信息，使用 `/done`；该操作不会自动导出 Specification。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/clarify <需求描述>` | 开始或继续梳理一个具体需求。 |
| `/clarify` | 打开已有澄清进度。 |
| `/new [标题]` | 创建独立会话并切换到它。 |
| `/sessions` | 列出当前项目工作目录中的会话。 |
| `/switch [session-id]` | 选择会话，或通过完整 ID 切换。 |
| `/rename <标题>` | 重命名当前会话。 |
| `/status` | 查看会话、Spec 和 Token 消耗信息。 |
| `/compact` | 对长对话中的旧上下文进行摘要。 |
| `/done` | 结束澄清，总结已确认信息和未决问题。 |
| `/language en-US` | 将全屏界面固定文案切换为英文。 |
| `/language zh-CN` | 将全屏界面固定文案切换为简体中文。 |
| `/quit` | 退出程序。 |

语言设置仅影响当前进程的界面固定文案，不翻译历史消息、Spec 或模型回复。
命令行帮助和部分提示仍为中文。

使用 `specpilot --help` 查看命令帮助，`specpilot --version` 查看已安装版本。
这两个命令无需 API 配置。

## 数据保存在哪里

会话、对话历史和澄清草稿保存在启动目录下的 `.specpilot/sessions-v5/`。
在同一目录重新启动时，会恢复上次活动会话；不同项目目录的会话互相独立。

导出 Spec 时，文件保存在：

```text
.specpilot/specs/<spec_id>/spec.json
.specpilot/specs/<spec_id>/SPEC.md
```

如果 `.specpilot/` 中包含私密项目信息，请避免将其提交到版本控制。
用于模型请求的仓库内容和对话上下文会发送到你配置的 API 服务。
将生成的需求用于开发前，请先审阅确认。

## 使用环境变量配置

脚本、CI 或已经使用 `.env` 的用户，也可以通过进程环境变量或项目目录中的 `.env`
提供 Anthropic 配置：

```dotenv
ANTHROPIC_API_KEY=你的_API_Key
MODEL_ID=服务商提供的模型标识
MAX_TOOL_USE_TURNS=20
```

使用兼容服务时，可额外设置 `ANTHROPIC_BASE_URL`。不要提交真实 API Key。

- 项目 `.env` 中的值优先于同名进程环境变量。
- 只要存在 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_BASE_URL`，即使值为空，也会优先使用这组
  连接配置，而非已保存的用户配置。需要使用用户连接配置时，请移除这两个字段。
- `MODEL_ID` 可以独立覆盖用户配置中的模型。
- `MAX_TOOL_USE_TURNS` 必须是正整数，默认值为 `20`。

非交互运行不会打开配置向导，需要提前配置，或提供上述变量。
`specpilot config` 必须在交互终端中执行。

## 当前限制

- 目前仅能运行 Anthropic 协议；OpenAI 仅支持保存配置。
- 同一个项目工作目录请只运行一个 SpecPilot 进程。恢复发生在完整轮次之间，
  不支持在模型或工具调用中途恢复；中断的工作不会自动重放。
- 旧格式的会话不会自动迁移。
- 长对话可能通过摘要缩减上下文，摘要可能丢失细节；完整对话历史仍保存在本地。

## 更新与反馈

```sh
npm install -g @fyismus/specpilot@latest
```

遇到问题或希望提出建议，请前往
[GitHub Issues](https://github.com/fynism/SpecPilot/issues)。

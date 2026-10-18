# TypeScript / Node.js 工程规范

## 基线

- 使用 Node.js 22.12+、ESM 与 TypeScript strict；依赖锁定在 `package-lock.json`。
- UTF-8、两空格缩进、行宽 100，由 Biome 自动格式化。
- 中文注释解释设计约束和信任边界；公开业务接口提供中文 JSDoc。
- 用户提示、帮助、错误和工具描述默认简体中文；TUI 固定词条可以切换英文。
- 代码标识符、模型协议字段和持久化 snake_case 字段保留英文；不能为了语言习惯改变旧 JSON。

## 类型与边界

- 开启 strict、noUncheckedIndexedAccess、noUnusedLocals 和 noUnusedParameters。
- 动态输入使用 unknown；Zod `strictObject` 拒绝多余字段和隐式类型转换。
- 从 Schema 推导类型；JSON Schema 使用 Zod 输入侧投影，保证模型可省略带默认值的字段。
- TypeScript 类型不能替代运行时校验；工具输入、交互回答、模型响应、文件和持久化均需复验。
- SDK 类型转换只停留在供应商适配器；领域模型不得依赖 React、Ink 或外部 SDK。
- 类和接口保持小范围，不引入无第二个实际使用场景的基础框架或抽象。

## 异步与错误

- 模型与文件流采用 Promise / async iterator；阻塞等待用户的 Python Presenter 改为异步端口。
- UI 只维护表现状态；工具、状态转换和终止由普通代码完成。
- 不静默吞异常，不把失败伪装成成功；在边界转换错误时使用 Error cause。
- SDK 和工具异常可能包含密钥，不将原文复制到模型、日志或终端。
- Hook 顺序固定，首个非空返回值短路；安全 Hook 异常不会放行处理函数。
- 文件资源和澄清 Promise 有明确关闭/取消路径；应用卸载唤醒尚在等待的 Presenter。

## 配置、路径和状态

- 配置在组合根集中读取，不能在模块导入时创建网络客户端或读取真实密钥。
- 工作区 .env 保留优先于进程环境的兼容行为。
- 用户 API 配置保存在 `~/.specpilot/config.json`，不随 Session 持久化或注入模型上下文。
  旧 Key / URL 字段存在时整组使用旧连接，不与用户文件混用凭据；模型可独立覆盖。
  用户配置第一版明文保存密钥，写入前限制文件权限（Windows 使用 ACL），不自动联网验证。
- 通过 Node path / fs 解析最终路径，在跟随符号链接后复验根目录。
- 持久化采用同目录临时文件和原子 rename，错误时清理临时文件并保留旧快照。
- Session 保持单进程写入与完整 Agent 轮次之间恢复，不宣称已有工具级 checkpoint。

## 检查与测试

```text
npm ci
npm run build
npm run typecheck
npm run lint
npm run tests
npm pack --dry-run
npm run smoke:package
```

`lint` 包含格式检查；`format` 仅是修复命令，不能代替验证。默认 Vitest 测试使用临时目录、
Fake Model / SDK transport 和 Ink testing library，不连接真实服务、不读取用户目录。
付费模型 Eval 保留单独开关。修复必须先添加能重现问题的回归测试，验证完整路径和失败边界。

## 依据

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Node.js 文件系统](https://nodejs.org/api/fs.html)
- [Zod JSON Schema](https://zod.dev/json-schema)
- [Ink](https://github.com/vadimdemedes/ink)
- [Vitest](https://vitest.dev/guide/)
- [Biome](https://biomejs.dev/)

# Python 工程规范

## 基线

- 目标运行时为 Python 3.11+；降低版本前必须确认所有语法和依赖兼容性。
- 使用 UTF-8、四空格缩进、绝对导入和 PEP 8 命名。
- 目标行宽为 100；格式最终由 Ruff 配置决定，禁止手工争论格式。
- 所有公开模块、类、函数和复杂私有函数必须有 docstring。
- 注释解释“为什么、约束和风险”，不要重复代码表面行为；代码变更时同步更新注释。

## 类型与数据契约

- 新增或修改的函数必须标注参数和返回类型。
- 禁止无理由传播 `Any`；动态 SDK 数据应在系统边界尽早转换为项目模型。
- 外部输入、工具参数、持久化数据和跨进程消息必须经过 Schema 校验。
- 领域模型不得依赖供应商响应对象；通过适配器转换成内部类型。
- `dict[str, Any]` 只允许停留在明确的序列化或 SDK 边界。

## 函数与异常

- 函数应完成一个可命名职责；副作用要能从名称或接口看出。
- 不使用裸 `except`，也不以 `except Exception: pass` 吞错。
- 在能够补充上下文的边界转换异常，并使用 `raise ... from exc` 保留原因链。
- 面向模型的失败返回结构化错误；面向程序员的错误应抛异常，不能伪装成成功字符串。
- 重试只针对已知瞬时错误，必须有次数、退避和幂等保障。

## 配置与依赖

- 配置集中定义并校验；业务代码不得随处读取环境变量。
- 密钥只从环境或专用 Secret Store 获取，禁止进入源码、日志、测试 fixture 或 Spec。
- 项目元数据、依赖与工具配置统一放在 `pyproject.toml`。
- 生产依赖与开发依赖分组；新增依赖必须说明必要性、维护状态、许可证和替代方案。
- 应使用锁文件获得可复现环境；升级依赖必须运行完整测试。

## 推荐自动化

目标工程配置应提供统一命令，至少覆盖：

```text
ruff format --check .
ruff check .
<type-checker> specpilot tests
pytest
```

类型检查器尚未选型前，不得在文档中声称已经完成严格类型检查。选择后固定在
`pyproject.toml` 和 CI 中。

## 文件与资源

- 路径使用 `pathlib.Path`；访问工作区前必须解析并验证边界。
- 文本读写显式指定 UTF-8。
- 临时文件使用系统临时目录，并通过上下文管理或 `finally` 清理。
- 持久化更新采用临时文件加原子替换，避免进程中断留下半写文件。

## 测试代码

- 测试目录与生产包分离，测试名称描述行为而非实现函数名。
- Fixture 小而明确；默认禁止真实网络、真实用户目录和真实云资源。
- Mock 系统边界，不要 Mock 被测模块内部每一步，否则重构会无意义地破坏测试。

## 依据

- [PEP 8](https://peps.python.org/pep-0008/)
- [Python typing specification](https://typing.python.org/en/latest/spec/)
- [Python Packaging User Guide](https://packaging.python.org/en/latest/tutorials/packaging-projects/)
- [Ruff documentation](https://docs.astral.sh/ruff/)
- [pytest Good Integration Practices](https://docs.pytest.org/en/stable/explanation/goodpractices.html)

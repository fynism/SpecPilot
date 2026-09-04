#!/usr/bin/env python3
"""SpecPilot 的兼容启动入口。

当前职责：
    保留 ``python code.py`` 这一最简单的启动方式，并把实际工作交给
    ``specpilot.cli``。入口本身不承载业务逻辑，避免项目继续退化为单文件脚本。

后续扩展：
    项目打包后可增加正式的 ``specpilot`` 控制台命令；此文件仍可作为学习者容易
    理解的入口，也可以在迁移期结束后删除。
"""

from specpilot.cli import main


if __name__ == "__main__":
    # 只有直接执行本文件时才启动 CLI；被测试或其他模块导入时不会产生交互。
    main()

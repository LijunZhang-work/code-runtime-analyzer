# 函数调用关系演示

这篇写给想体验网页函数调用关系的人。

示例代码位于 `src/energy_dispatch_demo.cpp`，包含数据采集、能量分配、安全约束、事件下发和基础服务等多个函数。焦点函数是 `run_dispatch_cycle`，它确实调用了其他函数，因此打开网页后可以看到真实连线。

## 使用步骤

1. 用 CMake 为这个演示生成 `compile_commands.json`；
2. 在 VS Code 中打开 `src/energy_dispatch_demo.cpp`；
3. 把光标放进 `run_dispatch_cycle` 函数；
4. 在右侧面板点击“打开网页工作台”。

开发者生成编译数据库的示例命令：

```powershell
cmake -S labs/code_structure_workbench_demo -B build/code_structure_workbench_demo -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

产品模块示例配置位于 `.cpp-csv-diagnostics/product-modules.json`。这里的数据和关系都来自真实演示代码，不是为了截图画出的假连线。

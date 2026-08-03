# 代码结构工作台真实 Demo

这个目录不是为了截图临时拼出的假数据。`src/energy_dispatch_demo.cpp` 是一份可以由 Clang 解析和编译的 C++ 示例，网页默认展示的函数、调用边和产品模块都与这里的代码及配置逐项对应。

- 焦点函数：`run_dispatch_cycle`
- 产品模块：数据采集、能量分配、安全约束、事件下发、基础服务
- 模块配置：`.cpp-csv-diagnostics/product-modules.json`

生成本机编译数据库：

```powershell
cmake -S . -B ../../build/code_structure_workbench_demo -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

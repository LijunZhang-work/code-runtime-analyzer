# Code Runtime Analyzer

一个把代码结构、产品功能模块和历史运行数据关联起来，帮助开发者理解系统并定位问题的分析平台。

当前版本提供三种入口，但共用同一套本地分析后端：

- **VS Code 扩展**：在代码行末、悬停窗口和趋势图中查看某个时间点的历史值；
- **网页工作台**：查看当前函数的直接调用关系，并跳回发起网页的同一个 VS Code 窗口；
- **OpenCode MCP**：让 AI 查询字典、CSV 时间点、字段证据、趋势和函数调用链。

## 第一次使用

1. 安装 Node.js 20 或更高版本、VS Code、clangd 和 CMake；
2. 在仓库根目录运行 `npm run install:all`；
3. 按 [工具使用指南](docs/工具使用指南.md) 安装并使用 VS Code 扩展；
4. 为自己的产品按 [字段字典填写指南](docs/字段字典填写说明.md) 新建字典；
5. 如果使用 OpenCode，直接从本仓库目录启动。仓库中的 `opencode.json` 会注册本地 MCP。

在本机 WSL 的 OpenCode 1.17.11 中，`opencode mcp list` 已实测显示 `cpp-csv-diagnostics connected`。

## 常用开发命令

```powershell
npm run install:all
npm test
```

`npm test` 会依次执行后端测试、VS Code 扩展 TypeScript 编译、网页 lint 和网页构建。

打包扩展前先运行 `npm run prepare:extension`。它会把唯一的后端源码、字典和最新网页构建复制到扩展包目录，避免仓库长期保存两份容易不一致的源码。

## 目录说明

- `backend/`：字典、CSV 会话、字段证据、Clang 调用链和 MCP 服务；
- `backend/dictionaries/`：随工具维护的产品字典，一份 CSV 对应一个产品；
- `extension/`：VS Code 扩展源码；
- `web/`：网页工作台源码；
- `labs/`：可公开的最小 C/C++ 演示工程；
- `examples/`：可公开的配置和数据格式示例；
- `docs/`：设计、使用和发布说明。

## 正确性与大型工程策略

- 只解析用户当前真正看得见的 C/C++ 编辑器，不扫描整个大型代码仓；
- 切换 CSV 时间点只查询数据，不重新解析 C/C++；
- 字典与 CSV 每次重新加载都会产生新版本，旧请求不能覆盖新结果；
- 当前可见文件的展示不会因缓存回收突然消失；不可见文件的重型解析缓存可以释放；
- 字典和 CSV 文件不会被工具擅自修改或删除；VS Code 重启后默认不展示旧数据。

提交代码前请阅读 [GitHub 发布清单](docs/GitHub发布清单.md)。真实日志、依赖目录、工具链、构建产物和密钥不得进入仓库。

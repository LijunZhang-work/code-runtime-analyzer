# OpenCode、网页工作台与 VS Code 联动

三个入口共用 `backend/` 中的同一套字典、CSV、版本校验和 Clang 分析逻辑，不会各自猜测字段含义。

## OpenCode MCP

仓库根目录 `opencode.json` 注册本地 MCP，提供：

- `diagnostics_list_dictionaries`：列出产品字典；
- `diagnostics_load_data`：选择字典、CSV 文件夹和代码仓；
- `diagnostics_list_replay_times`：列出可查询时间点；
- `diagnostics_list_fields`：列出字典确认的代码字段；
- `diagnostics_get_snapshot`：查询某时间点的字段证据；
- `diagnostics_get_series`：查询字段趋势；
- `diagnostics_get_call_graph`：通过 Clang AST 查询直接调用链；
- `diagnostics_make_vscode_link`：生成普通 VS Code 定位链接。

本机 WSL OpenCode 1.17.11 已实际验证为 `connected`。详细操作见 [工具使用指南](工具使用指南.md)。

## 网页与当前 VS Code 窗口绑定

必须从 VS Code 右侧面板点击“打开网页工作台”。扩展会生成仅属于当前窗口的本地会话。网页点击“在当前 VS Code 中定位”时，通过该会话回到原窗口，而不是调用容易新开窗口的系统级链接。

网页只接受当前工作区内的文件，并从光标所在函数开始展示当前编译单元中可确认的直接调用关系。限制范围是为了大型项目的速度和可读性，不代表项目只有这些函数。

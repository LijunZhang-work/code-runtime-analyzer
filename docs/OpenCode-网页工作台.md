# OpenCode 使用说明

这篇写给想让 OpenCode 查询历史数据或代码调用关系的人。如果你只使用 VS Code 右侧面板，可以不看这篇。

## 一、OpenCode 在这里起什么作用

OpenCode 不会替代 VS Code 扩展。它只是通过 MCP 调用同一个本地后端，让 AI 可以：

- 列出有哪些产品字典；
- 加载一个 CSV 文件夹；
- 查询有哪些历史时间点；
- 查询某个字段在某个时间的值；
- 查询一个字段的变化趋势；
- 分析当前 C/C++ 文件中的直接函数调用关系。

VS Code、网页和 OpenCode 使用同一套字典与匹配规则，不会各自重新猜一遍。

## 二、使用前准备

1. 已经按照根目录 README 安装了后端依赖；
2. OpenCode 已经安装；
3. 从这个仓库根目录启动 OpenCode；
4. 仓库根目录存在 `opencode.json`。

当前电脑的 OpenCode 在 WSL 中，而 Node.js 安装在 Windows，所以 `opencode.json` 使用 `node.exe`。这套配置已经在 WSL OpenCode 1.17.11 中实测连接成功。

## 三、先检查是否连接成功

在 WSL 中进入你克隆本仓库的位置：

```bash
cd /mnt/<盘符>/<你的克隆目录>
opencode mcp list
```

如果看到：

```text
cpp-csv-diagnostics connected
```

就表示可以用了。

如果显示 `Executable not found: node`，说明 OpenCode 在 WSL、Node.js 在 Windows。确认 `opencode.json` 中使用的是 `node.exe`。

如果另一台电脑在 Linux 或 macOS 原生运行 OpenCode，把 `node.exe` 改成 `node`。

## 四、可以怎样问 OpenCode

不要一上来就说“帮我分析所有东西”。按下面顺序更容易得到明确结果：

1. “列出当前可以使用的产品字典。”
2. “使用 product-a 字典，加载 `/你的/CSV/文件夹`，代码仓是 `/你的/代码仓`。”
3. “列出这批 CSV 可以查询的时间点。”
4. “查询 `school::Student::age` 在时间点 XXX 的值和数据来源。”
5. “显示这个字段的变化趋势。”

查询函数调用关系时，需要同时提供：

- `compile_commands.json` 的位置；
- 要分析的 `.c`、`.cc` 或 `.cpp` 文件；
- 函数名或函数所在行。

## 五、这些工具名是什么意思

普通用户不需要记住工具名，OpenCode 会选择。但排查问题时可以对照：

| 工具 | 大白话作用 |
| --- | --- |
| `diagnostics_list_dictionaries` | 看有哪些产品字典 |
| `diagnostics_load_data` | 加载字典和这次 CSV 文件夹 |
| `diagnostics_list_replay_times` | 看有哪些时间点 |
| `diagnostics_list_fields` | 看字典已经确认了哪些代码字段 |
| `diagnostics_get_snapshot` | 查某个时间点的值 |
| `diagnostics_get_series` | 查一段时间的趋势 |
| `diagnostics_get_call_graph` | 查直接函数调用关系 |

## 六、网页为什么要从 VS Code 打开

从 VS Code 右侧面板点击“打开网页工作台”时，网页会记住是哪个 VS Code 窗口打开了它。

这样网页中的“在当前 VS Code 中定位”才能回到原来的窗口。如果直接复制一个普通 `vscode://` 链接，操作系统可能新开另一个 VS Code 窗口。

网页只允许跳转到当前代码仓内部的文件，也只展示当前编译单元中能够确认的直接调用关系。这样做是为了大型项目的速度、准确性和可读性。

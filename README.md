# Code Runtime Analyzer

这个工具能把 **CSV 日志里的历史数据**，显示到对应的 **C/C++ 代码旁边**。

比如 CSV 里记录了某个学生在不同时间的 `age`，代码里有 `Student::age`。选择一个时间点后，工具可以在使用 `Student::age` 的代码旁显示当时的值。你不需要自己在几万行日志里来回查找。

## 第一次接触？只看这里

你不需要先读架构文档。根据自己要做的事情，直接点下面的说明：

| 你现在想做什么 | 应该看哪篇 |
| --- | --- |
| 我第一次使用，完全不知道从哪里开始 | **[新手从这里开始](docs/新手从这里开始.md)** |
| 我已经安装了工具，想知道右侧面板怎么点 | **[工具使用指南](docs/工具使用指南.md)** |
| 我要给自己的产品新增一份字段字典 | **[字段字典填写指南](docs/字段字典填写说明.md)** |
| 我要让 OpenCode 使用这个工具 | [OpenCode 使用说明](docs/OpenCode-网页工作台.md) |
| 我要把项目提交到 GitHub | [GitHub 发布清单](docs/GitHub发布清单.md) |

如果你只是普通使用者，看到这里就够了。后面的内容主要给安装、开发和维护这个工具的人看。

## 使用时，你只需要准备三样东西

1. **代码仓**：你要分析的 C/C++ 项目文件夹；
2. **字段字典**：告诉工具“CSV 的这一列对应代码里的什么”；
3. **CSV 文件夹**：本次导出的日志，可以同时包含多份 CSV。

然后在 VS Code 右侧“历史诊断”面板里按顺序操作：

```text
选择字典 → 选择 CSV 文件夹 → 重新加载 → 选择时间 → 开始展示
```

详细到每一个按钮的说明，请看 [工具使用指南](docs/工具使用指南.md)。

## 字典到底是什么

字典就是一张人工确认的“翻译表”。例如：

```csv
data_source,data_field,target_kind,target,definition_path
student.csv,timestamp,time,unix_ms,
student.csv,age,member,school::Student::age,src/student.hpp
```

第二行的意思是：

> `student.csv` 里的 `age`，就是代码中 `src/student.hpp` 定义的 `school::Student::age`。

这五列分别怎么填、结构体和全局变量怎么写，请看 [字段字典填写指南](docs/字段字典填写说明.md)。

## 给开发者的安装和检查命令

需要 Node.js 20 或更高版本。在仓库根目录运行：

```powershell
npm run install:all
npm test
```

`npm test` 会检查后端、VS Code 扩展和网页工作台。

打包扩展前运行：

```powershell
npm run prepare:extension
```

它会把后端、字典和网页构建结果放进扩展包需要的位置。

## 项目中各文件夹是干什么的

- `backend/`：读取字典和 CSV、查询历史值、分析函数调用关系；
- `backend/dictionaries/`：产品字典，一份 CSV 字典代表一个产品；
- `extension/`：VS Code 右侧面板和代码行末展示；
- `web/`：网页函数调用关系界面；
- `labs/`：可以放心练习的 C/C++ 演示项目；
- `runs/`：演示 CSV，以及本机临时日志目录；
- `docs/`：使用说明和技术设计文档。

## 已验证的状态

- 后端自动测试：45 项全部通过；
- VS Code 扩展：编译通过；
- 网页工作台：检查和生产构建通过；
- 2048 C++ 演示：编译并生成 CSV 成功；
- WSL 中 OpenCode 1.17.11：MCP 显示 `connected`。

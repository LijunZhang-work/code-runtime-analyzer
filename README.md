# Code Runtime Analyzer

这个工具能把 **CSV 日志里的历史数据**，显示到对应的 **C/C++ 代码旁边**。

比如 CSV 里记录了某个学生在不同时间的 `age`，代码里有 `Student::age`。选择一个时间点后，工具可以在使用 `Student::age` 的代码旁显示当时的值。你不需要自己在几万行日志里来回查找。

## GitHub 同时提供三类可直接安装的包

请到 [GitHub Releases（正式安装包）](https://github.com/LijunZhang-work/code-runtime-analyzer/releases/latest) 下载同一版本需要的文件：

1. `Code-Runtime-Analyzer-Setup-v*.exe`：只安装独立后台、后台控制中心和 Web 工作台；
2. 两个二选一的 `.vsix`：单独安装到你实际使用的编辑器，包括兼容 VS Code 扩展接口的公司定制版编辑器；
   - `Code-Runtime-Analyzer-默认右侧栏-v*.vsix`：优先安装，功能面板位于编辑器右侧栏；
   - `Code-Runtime-Analyzer-兼容布局-v*.vsix`：默认版被拒绝安装，或重新加载后仍找不到“历史诊断”时再用；扩展自身功能相同，但入口可能在左侧，代码能力以自动检测结果为准。
3. `Code-Runtime-Analyzer-MCP-v*.tgz`：需要 OpenCode / AI 时，由用户或 AI 单独安装到对应环境。

安装程序会一起安装：

- 独立后台核心系统；
- Web 工作台；
- 工具自己的 Node.js 运行时；
- 随安装包提供的示例产品字典。

EXE **不会查找、修改或启动任何编辑器，也不会偷偷安装扩展或 MCP**。扩展和 MCP 是否安装成功，以实际编辑器和 OpenCode 的连接状态为准。直接使用 EXE 和 VSIX 不需要运行 npm。

安装 EXE 后，可以从 Windows 开始菜单打开 `Code Runtime Analyzer → 后台控制中心`，查看后台是否运行、启动、停止、重启或打开日志。只看见 Web 页面不代表扩展或 MCP 已经安装；它们是分开的组件。

```text
                    OpenCode + AI
                          │ MCP
                          ▼
编辑器扩展  ◀────── 独立后台核心 ────▶ Web 工作台
                          │
        字典 / CSV / 窗口连接 / 模块 / 安全缓存
```

## 第一次接触？只看这里

你不需要先读架构文档。根据自己要做的事情，直接点下面的说明：

| 你现在想做什么 | 应该看哪篇 |
| --- | --- |
| 我还没有安装，想要最简单的安装步骤 | **[工具使用指南：后台和扩展分别安装](docs/工具使用指南.md)** |
| 我第一次使用，完全不知道从哪里开始 | **[新手从这里开始](docs/新手从这里开始.md)** |
| 我已经安装了工具，想知道“历史诊断”面板怎么点 | **[工具使用指南](docs/工具使用指南.md)** |
| 我要给自己的产品新增一份字段字典 | **[字段字典填写指南](docs/字段字典填写说明.md)** |
| 我要让 OpenCode 使用这个工具 | [OpenCode 使用说明](docs/OpenCode-网页工作台.md) |
| 公司下载 Release 很慢，想从源码自己生成安装包 | [从源码生成全部安装包](docs/从源码生成安装包.md) |

如果你只是普通使用者，看到这里就够了。后面的内容主要给安装、开发和维护这个工具的人看。

## 使用时，你只需要准备三样东西

1. **代码仓**：你要分析的 C/C++ 项目文件夹；
2. **字段字典**：告诉工具“CSV 的这一列对应代码里的什么”；
3. **CSV 文件夹**：本次导出的日志，可以同时包含多份 CSV。

然后在编辑器的“历史诊断”面板里按顺序操作：

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

## 给维护者的源码安装和检查命令

这一节只给修改源码、制作下一版安装包的人看。普通使用者跳过即可。

需要 Node.js 20 或更高版本。在仓库根目录运行：

```powershell
npm run install:all
npm test
```

`npm test` 会先生成后端旧离线能力所需的独立测试夹具，再检查后端、编辑器扩展和网页工作台。当前编辑器在线主流程不要求用户提供 `compile_commands.json`，测试也不依赖开发者电脑里以前留下的 `build` 文件。

打包扩展前运行：

```powershell
npm run prepare:extension
```

它会把后端、字典和网页构建结果放进扩展包需要的位置。

提交一个形如 `v0.10.0` 的版本标签后，GitHub 会自动制作 Release，同时生成 Windows 后台 EXE、编辑器 VSIX 和独立 MCP 包。维护流程见 [GitHub 发布清单](docs/GitHub发布清单.md)。如果 Release 下载很慢，也可以下载源码后运行一条本地构建命令，见 [从源码生成安装包](docs/从源码生成安装包.md)。

## 项目中各文件夹是干什么的

- `backend/`：读取字典和 CSV、查询历史值、管理窗口连接并转发语义请求；
- `backend/dictionaries/`：产品字典，一份 CSV 字典代表一个产品；
- `extension/`：编辑器能力检测、历史诊断面板和代码行末展示；
- `web/`：网页函数调用关系界面；
- `labs/`：可以放心练习的 C/C++ 演示项目；
- `runs/`：演示 CSV，以及本机临时日志目录；
- `docs/`：使用说明和技术设计文档。

## 已验证的状态

- 后端自动测试：55 项全部通过；
- 编辑器扩展：编译通过，并能生成默认右侧栏版和兼容布局版；
- 网页工作台：检查和生产构建通过；
- 2048 C++ 演示：编译并生成 CSV 成功；
- WSL 中 OpenCode 1.17.11：MCP 显示 `connected`。

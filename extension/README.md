# Code Runtime Analyzer 编辑器扩展

这个 VSIX 是编辑器与 Code Runtime Analyzer 后台之间的连接器。它负责：

- 在代码行末显示已经确认匹配的 CSV 历史值；
- 使用当前编辑器已有的语言服务确认定义、类型、引用和函数调用关系；
- 把 Web 工作台绑定到打开它的这个编辑器窗口；
- 自动检测当前编辑器真正可用的能力，并给出简短结论和详细解释。

EXE 只安装独立后台、后台控制中心和 Web，不会自动安装扩展或 MCP。普通用户请从 [GitHub Releases](https://github.com/LijunZhang-work/code-runtime-analyzer/releases/latest) 下载同一版本的 EXE，并在实际使用的编辑器中单独安装一个 VSIX：

- `Code-Runtime-Analyzer-VSCode-Right-Sidebar-v*.vsix`：优先安装；
- `Code-Runtime-Analyzer-VSCode-Compatible-v*.vsix`：默认版被拒绝安装，或重新加载后仍找不到“历史诊断”时使用；入口可能在左侧活动栏。

两个 VSIX 的扩展源码和自身功能相同、扩展 ID 相同，只安装一个。编辑器实际能提供多少类型和调用关系能力，以安装后的自动检测为准。普通用户不需要 Node.js 或 npm。

扩展默认采用“自动”后台模式：优先连接 EXE 提供的独立后台；没有安装或没有启动时，自动使用 VSIX 自带后台。只安装 VSIX 也能使用编辑器内的历史诊断，而且打开编辑器时不会弹出后台健康检查错误。OpenCode、常驻 Web 工作台和跨窗口共享仍需独立后台。

维护者在仓库根目录生成两个扩展包：

```powershell
.\build.ps1 extension
```

完整的新手安装和检测流程见仓库中的 `docs/工具使用指南.md`。

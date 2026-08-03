# Code Runtime Analyzer VS Code 扩展

普通用户请到 [GitHub Releases](https://github.com/LijunZhang-work/code-runtime-analyzer/releases/latest) 下载 `Code-Runtime-Analyzer-Setup-v*.exe`。一个安装程序会同时安装：

- 独立后台核心；
- 网页工作台；
- OpenCode/AI 使用的 MCP 服务；
- 自带运行环境；
- VS Code 扩展。

普通用户不需要安装 Node.js，也不需要运行 npm。

同一发布页中的 `.vsix` 只是“单独安装或更新 VS Code 扩展”的备用包。只安装 `.vsix` 时，扩展可以使用内嵌后台，但不会得到完整的独立后台、统一网页和 OpenCode/AI 接入能力。

这个目录保存的是扩展源码。只有维护者打包时，才从仓库根目录运行：

```powershell
npm run prepare:extension
npm --prefix extension run compile
```

GitHub 收到 `v*` 版本标签后会同时生成 Windows 一键安装程序和 `.vsix` 备用包。扩展中的 `backend/` 是打包时临时生成的目录，不在 Git 中保存。

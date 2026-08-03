# Code Runtime Analyzer VS Code 扩展

普通使用者请到 [GitHub Releases](https://github.com/LijunZhang-work/code-runtime-analyzer/releases/latest) 下载 `.vsix` 安装包，然后在 VS Code 中选择“扩展 → `...` → 从 VSIX 安装”。不需要安装 Node.js 或运行 npm。

这个目录同时也保存扩展源码。只有维护者打包下一版时，才从仓库根目录运行：

```powershell
npm run prepare:extension
npm --prefix extension run compile
```

GitHub 在收到 `v*` 版本标签时，会自动构建并发布 `.vsix`。扩展的 `backend/` 是打包时生成的目录，不在 Git 中保存；生成过程会复制唯一的后端源码、产品字典和最新网页构建，避免两份源码长期漂移。

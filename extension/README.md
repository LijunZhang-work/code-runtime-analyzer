# Code Runtime Analyzer VS Code 扩展

这个目录保存扩展源码。日常使用方式见仓库根目录的 `docs/工具使用指南.md`。

扩展的 `backend/` 是打包时生成的目录，不在 Git 中保存。打包前从仓库根目录执行：

```powershell
npm run prepare:extension
npm --prefix extension run compile
```

生成过程会复制根目录中唯一的后端源码、产品字典和最新网页构建，避免两份源码长期漂移。

# Code Runtime Analyzer 网页工作台

网页工作台使用 React、React Flow 和 Motion，展示当前函数在当前编译单元中能够由 Clang 确认的直接调用关系。

```powershell
npm ci
npm run lint
npm run build
```

网页不能脱离本地后端单独提供真实分析结果。正常入口是从 VS Code 右侧“历史诊断”面板打开，以便网页绑定回发起它的那个 VS Code 窗口。

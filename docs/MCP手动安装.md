# MCP 手动安装说明

MCP 与 EXE、编辑器扩展互相独立。EXE 不会修改 OpenCode、WSL 或任何 AI 环境。

## 安装前准备

1. 先安装并启动 Code Runtime Analyzer 后台；
2. 从 GitHub Release 下载与后台同版本的 `Code-Runtime-Analyzer-MCP-v*.tgz`；
3. OpenCode 所在环境需要 Node.js 20 或更高版本。

## 在 OpenCode 所在环境安装

如果 OpenCode 在 WSL 中运行，就在 WSL 终端执行。下面路径只是例子，请换成真实下载位置：

```bash
npm install --global /mnt/c/Users/你的用户名/Downloads/Code-Runtime-Analyzer-MCP-v0.10.0.tgz
```

如果 OpenCode 直接运行在 Windows 中，就在 PowerShell 执行：

```powershell
npm install --global .\Code-Runtime-Analyzer-MCP-v0.10.0.tgz
```

安装后，命令名是：

```text
code-runtime-analyzer-mcp
```

先检查它能否连接已经启动的后台：

```text
code-runtime-analyzer-mcp --check
```

成功时会明确显示后台地址、后台版本和 API 版本；失败时会说明是后台未启动还是版本不兼容。

然后在 OpenCode 配置中添加网页“AI 与扩展”页面提供的配置。EXE 不会替你写入配置，也不会覆盖另一个项目已有的 MCP。

## 怎样确认成功

必须同时满足：

1. OpenCode 的 MCP 列表显示 `code-runtime-analyzer` 已连接；
2. Code Runtime Analyzer 网页“AI 与扩展”页面出现一个在线 AI 客户端。

仅仅下载了 TGZ、运行过安装命令，或者后台目录里存在 `mcp-server.mjs`，都不能算连接成功。

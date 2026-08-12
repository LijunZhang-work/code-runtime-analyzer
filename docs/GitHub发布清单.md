# GitHub 发布清单

这篇写给准备提交代码的人。它只回答“哪些文件能上传、哪些不能上传”，以及如何让 GitHub 自动生成后台 EXE、独立 VSIX 和独立 MCP 包；普通使用者不需要阅读。

## 可以提交

- `backend/src`、`backend/test`、`backend/dictionaries`：后端源码、测试和产品字典；
- `extension/src`、`extension/media` 及扩展配置：编辑器扩展源码；
- `web/src`、`web/public` 及前端配置：网页源码；
- `docs`、`README.md`：说明和设计文档；
- `labs`、`examples`：确认是虚构数据的最小演示；
- `package.json`、各目录的 `package-lock.json`：可重复安装依赖所需文件；
- `.vscode` 中不含个人绝对路径和密钥的共享任务配置。

## 不可以提交

- `node_modules`：体积大，可由锁文件恢复；
- `tools`、`build`、`third_party`：本机工具链、编译产物、下载的第三方演示源码；
- `out`、`dist`、`web-dist`、`extension/backend`、`*.vsix`：可重新生成的产物、打包副本和历史安装包；
- `runs` 中除两份 2048 虚构演示以外的 CSV：用户临时导出的真实运行日志；
- `*.log`：后台输出可能带本机路径或业务数据；
- `.env`、密钥、证书、数据库文件和访问令牌；
- 含 `C:\Users\...`、`E:\...` 等个人绝对路径的机器配置；
- 未确认授权的客户代码、生产配置、设备数据和第三方素材。

## 每次推送前

1. 查看 `git status --short`，确认没有意外文件；
2. 检查新增 CSV/JSON/日志是否是虚构演示数据；
3. 搜索令牌、密码、私钥和个人绝对路径；
4. 执行 `npm test`；
5. 只提交本次确认过的文件，不使用“把所有未知文件都传上去”的做法。

`.gitignore` 是第一道防线，不是保密保证。文件一旦被 Git 跟踪，后来再写进 `.gitignore` 也不会自动从历史中删除。

## 发布给普通用户

正式发布时，在已经检查通过的提交上创建一个版本标签，例如 `v0.10.2`，并把该标签推送到 GitHub。用户可以下载 Release 里的现成包；Release 下载很慢时，也可以下载同一版本源码后本地生成。

当前发布包不做代码签名，所以部分 Windows 电脑可能显示“未知发布者”或 SmartScreen 提示。项目仍然不会提交 `.pfx`、证书密码或私钥。

GitHub Actions 会自动完成下面八件事：

1. 安装构建依赖、构建网页和扩展；
2. 生成 `Code-Runtime-Analyzer-Setup-v0.10.2.exe`，其中只包含独立后台、后台控制中心、Web 和运行时，不包含 MCP，不查找也不修改任何编辑器；
3. 从同一份源码生成 `Code-Runtime-Analyzer-默认右侧栏-v0.10.2.vsix` 和 `Code-Runtime-Analyzer-兼容布局-v0.10.2.vsix`；用户只安装其中一个；
4. 单独生成 `Code-Runtime-Analyzer-MCP-v0.10.2.tgz`，供用户或 AI 安装到 OpenCode 所在环境；
5. 生成 `SHA256SUMS.txt`，方便核对下载文件没有损坏或被替换；
6. 在一次性的 Windows 虚拟机中实际安装 EXE，确认后台健康、诊断导出、重复安装和卸载正常，并确认编辑器扩展目录完全没有变化；
7. 执行 250、2500、10000 个代码文件三档性能门禁，确认代码仓变大时仍只分析和缓存当前文件；固定 OpenCV 真实项目另有每周测试；
8. 在 GitHub 的 **Releases** 页面创建对应版本，并把四个安装包和校验文件放进去。

这样用户可以直接下载四个现成安装包，也可以下载源码后运行 `.\build.ps1 all` 自己生成。所有文件应使用同一个版本号。版本号只在真正要发给用户的新安装包时才增加，不因为日常的小修改频繁变化。

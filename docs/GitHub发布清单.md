# GitHub 发布清单

这篇写给准备提交代码的人。它只回答“哪些文件能上传、哪些不能上传”，以及如何让 GitHub 自动生成统一安装程序和备用 `.vsix`；普通使用者不需要阅读。

## 可以提交

- `backend/src`、`backend/test`、`backend/dictionaries`：后端源码、测试和产品字典；
- `extension/src`、`extension/media` 及扩展配置：VS Code 扩展源码；
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

普通用户不下载源码。正式发布时，只需要在已经检查通过的提交上创建一个版本标签，例如 `v0.10.0`，并把该标签推送到 GitHub。

GitHub Actions 会自动完成下面五件事：

1. 安装构建依赖、构建网页和扩展；
2. 生成 `Code-Runtime-Analyzer-Setup-v0.10.0.exe`，其中包含独立后台、Web、MCP、运行时和 VS Code 扩展；
3. 同时生成一个只用于扩展更新和备用体验的 `.vsix`；
4. 生成 `SHA256SUMS.txt`，方便核对下载文件没有损坏或被替换；
5. 在 GitHub 的 **Releases** 页面创建对应版本，并把安装包和校验文件放进去。

这样普通用户只需双击 `.exe`。版本号只在真正要发给用户的新安装包时才增加，不因为日常的小修改频繁变化。

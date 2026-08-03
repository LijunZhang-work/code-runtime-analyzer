# 2048 CSV 回放实验场

该实验场使用上游 `third_party/2048.cpp-master` 的公开 `GameBoard` 与 `tile_t` 数据结构，不修改上游源码。它构造 4 组确定性诊断棋盘，每组记录向左移动前、移动后两个快照，共 8 个时间点。各组是独立重置的诊断夹具，不代表一局连续游戏；这里的移动逻辑也不能替代完整 2048 游戏实现。

## 0.4.0 演示数据

在 VS Code 右侧 **历史诊断** 面板选择：

- 字典：`2048-demo`；
- CSV 文件夹：仓库根目录下的 `runs/`。

后台会一次加载两个精确来源：

- `2048_demo_run.csv`：`TILE_<index>_VALUE/BLOCKED`；
- `2048_metrics.csv`：`score`、`largest_tile`、`moved`。

两份文件都使用 Unix 毫秒 `timestamp`，各有 8 个时间点。标准 CSV 没有 sheet；文件名和大小写必须与字典完全一致。

唯一有效的演示字典是 [backend/dictionaries/2048-demo.csv](../../backend/dictionaries/2048-demo.csv)。旧 `field-mappings.csv`、`replay-mapping.json` 和 `replay-run-config.json` 均已删除，0.4.0 不再使用旧的自动导入配置流程。

字段的真实定义位置为：

- `Game::tile_t::value/blocked`：`third_party/2048.cpp-master/src/headers/tile.hpp`；
- `Game::GameBoard::score/moved/largestTile`：`third_party/2048.cpp-master/src/headers/gameboard.hpp`。

源码中的 `set_board`、`write_snapshot`、`apply_move` 和 `main` 包含可由 Clang 确认的成员访问。`current`、`target` 等引用只能确认 owner 类型，无法仅凭静态源码确定当次循环对应的 tile 下标，因此界面展示的是相应字段的全实例时间点快照。

构建信息由 0.4.0 自动发现 `compile_commands.json`；用户不需要维护实验 JSON 或手工填写某台电脑的绝对 build 路径。生成的演示 CSV 写入 `runs/`。

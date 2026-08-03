# 2048 CSV 回放演示

这篇写给想先用虚构数据试一遍工具的人。演示不会读取真实产品日志。

## 怎么加载演示

在 VS Code 右侧“历史诊断”面板中选择：

- 字段字典：`2048-demo`；
- CSV 文件夹：仓库根目录下的 `runs/`。

然后依次点击：

```text
加载 / 重新加载字典 → 加载 / 重新加载 CSV → 选择时间 → 开始展示
```

工具会加载：

- `2048_demo_run.csv`：16 个棋盘格的值和阻塞状态；
- `2048_metrics.csv`：分数、最大方块和是否发生移动。

两份 CSV 都有 8 个虚构时间点。

## 字典和代码在哪里

- 演示字典：`backend/dictionaries/2048-demo.csv`；
- 棋盘类型：`labs/2048_csv_replay/include/gameboard.hpp`；
- 格子类型：`labs/2048_csv_replay/include/tile.hpp`；
- 产生数据的代码：`labs/2048_csv_replay/src/replay_scenario.cpp`。

这些文件全部在仓库里，不依赖本机 `third_party` 下载目录，所以新电脑克隆仓库后仍可以使用。

## 为什么同一个字段会显示多个值

棋盘有 16 个 `tile_t`。字典中的 `TILE_{index}_VALUE` 会展开为 0 到 15，因此 `tile_t::value` 在一个时间点有 16 个实例值。

仅看静态 C++ 代码时，工具能确认 `current.value` 的类型是 `tile_t::value`，但不能假装知道某次循环中的 `current` 一定是第几个格子，所以界面会保留所有有来源的实例。

## 如何重新生成演示 CSV

这一步只给开发者使用。先用 CMake 生成 `compile_commands.json` 并编译，再运行 `2048_csv_replay`。普通使用者直接使用 `runs/` 中已经提供的演示 CSV 即可。

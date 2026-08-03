# 最小字典示例

这个目录写给想快速看懂“CSV 怎么对应 C++”的人。

- `boss_control.cpp`：定义了 `BossInfo::bossId` 和 `BossInfo::status`；
- `boss_log.csv`：包含三个 Boss 在三个时间点的虚构数据；
- `boss-demo-dictionary.csv`：把 CSV 数组列映射到两个结构体字段。

例如：

```csv
boss_log.csv,BOSS_{index}_STATUS,member,BossInfo::status,examples/boss_control.cpp
```

意思是：`boss_log.csv` 中形如 `BOSS_0_STATUS`、`BOSS_1_STATUS` 的列，都属于代码里的 `BossInfo::status`，数字是实例下标。

这份字典放在 `examples/` 是为了阅读。如果要在右侧面板中选择它，请复制到 `backend/dictionaries/`，然后点击“加载 / 重新加载字典”。

# 从 1.x / 2.0 升级到 3.x

## 结论：数据不用迁移

| 文件 | 格式 | 3.x 是否兼容 |
|---|---|---|
| `userdata/data/structures.json` | JSON | ✅ 完全兼容 |
| `userdata/data/settings.json` | JSON | ✅ 完全兼容 |
| `userdata/data/nbt/*.mcstructure` | 结构文件 | ✅ 完全兼容（**不需要重新保存**） |
| `userdata/config/configs.json` | 带注释 JSON | ✅ 兼容；废弃键会被忽略（见[配置参考](user/config.md)） |

升级方式：**覆盖程序文件，保留 `userdata` 目录**。

## 行为变化（升级后可能"感觉不一样"的地方）

### 1. 不再自动更新

1.x 的 `autoUpdate` / `updateFrom` 已移除。更新方式改为：下载新 zip → 覆盖 → 重启。两个键留在配置里无效，可以删除。

### 2. 进度提示从 boss 条改成文字

1.x 用 boss 条显示进度。**boss 条颜色越界会让客户端直接掉线**（3.0 已修），所以 3.x 一律改为文字提示。个人设置里的 `displayProgressBar` 仍然有效，只是呈现方式变了。

### 3. 不再传送玩家

1.x 为了加载远处区块会把玩家传送来传送去。3.x 改用 `/tickingarea` 常加载区块，**操作期间玩家的位置不会有任何变化**。

### 4. 大选区需要更久，但会显示进度

大区域第一次操作需要生成区块，可能要等几秒到几十秒（`chunkLoadTimeout` 默认 15 秒）。这是正常现象。

### 5. 选区显示的默认方式

默认是 `structure_block`（在原版里也是这样）。如果不想让世界中出现临时结构方块，可以改成 `text` 或 `off`。

## 已知限制

见[已知限制](other/limitations.md)。其中最需要注意的是 **方块实体内容（箱子、告示牌）不会被恢复**，以及**含水方块会变干**。

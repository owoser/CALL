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


## 3.1.0：目录结构变更（自动迁移）

3.1.0 把原来七零八落的目录拍平了：

| 旧（3.0.x 及更早） | 新（3.1.0） |
|---|---|
| `plugins/CALL/userdata/config/configs.json` | `plugins/CALL/config/configs.json` |
| `plugins/CALL/userdata/config/userlist.json` | `plugins/CALL/config/userlist.json` |
| `plugins/CALL/userdata/config/stupid_permission_file.json` | `plugins/CALL/config/permission.json` |
| `plugins/CALL/userdata/data/**` | `plugins/CALL/data/**~` |
| `plugins/CALL/userdata/plugins/**` | `plugins/CALL/data/shapes/**` |
| `plugins/CALL/userdata/import` / `export` | `plugins/CALL/data/import` / `export` |
| `plugins/CALL/config/` 里的 check.json、lang/、icons.json、item_texture.json 等 | `plugins/CALL/assets/`（只读资源） |
| `userdata/temp`、`userdata/build`、`config/update.json`、`config/url.json` | 已删除（本来就没用到） |

**你不需要做任何事**：

1. 直接覆盖 ~`~plugins/CALL~` 里的程序文件（保留 ~`~config/~`~、~`~data/~`~ 或旧的 ~`~userdata/~`~ 都行）；
2. 启动服务器，插件会在打开任何文件之前自动迁移；
3. 控制台会打印 ~`~[CALL] layout migrated: N file(s) moved...~`~ 和新的 ~`~[CALL] config: ...~`~ / ~`~[CALL] data: ...~`~ 路径。

迁移的安全性：

- **目标已存在就不覆盖**，旧文件会被改名成 ~`~*.old~`~ 保留给你检查；
- 迁移失败时**保留原文件**并在控制台打 WARN，插件继续用新路径运行；
- 迁移完成后 ~`~userdata/~`~ 只在**完全为空**时才会被删除。

## 依赖安装方式的变化（3.1.0）

发布包不再内置 ~`~node_modules~`~（省 2.1 MB）。首次启动时 LSE 会为插件执行
~`~npm install --omit=dev~`~ 安装依赖：

- 服务器能访问 npm 源：什么都不用做，首次启动会慢一点；
- **离线服务器**：请用发布页的 ~`~CALL-<版本>-full.zip~`~（内置依赖），或在插件目录手动跑一次 ~`~npm install --omit=dev~`~。

## 已知限制

见[已知限制](other/limitations.md)。其中最需要注意的是 **方块实体内容（箱子、告示牌）不会被恢复**，以及**含水方块会变干**。
# 配置参考

?> 如果你不是服务器管理员，可以跳过本节。

## 配置文件在哪

配置文件的真实路径是：

~~~text
plugins/CALL/assets/configs.json
~~~

Windows 服务器上形如 `F:\SER-01\plugins\CALL\userdata\config\configs.json`。启动日志里也会打印一次这个绝对路径（`[CALL] config: ...`），不确定时直接看日志。

!> **原版文档写的 `CALL/assets/configs.json` 是笔误。**
原作者 1.6.1 的代码里配置一直写在 `config` 下；`plugins/CALL/assets/` 只放只读资源（`check.json`、`help.json`、`icons.json`、`item_texture.json`、`url.json`、`lang/*.lang`），**不要**去那里找。

## 目录职责

| 目录 | 内容 | 是否可改 |
|---|---|---|
| `plugins/CALL/core/` | 程序代码 | ❌ |
| `plugins/CALL/assets/` | 只读资源：语言包、图标、贴图索引、校验规则、导入导出工具 | ❌ 不要改 |
| `plugins/CALL/config/` | **configs.json（本文档）**、userlist.json（白名单）、permission.json | ✅ 你的配置 |
| `plugins/CALL/data/` | nbt/（结构切片）、shapes/（形状包）、import/、export/、settings.json、structures.json | ✅ 你的数据 |

> 3.0.x 及更早版本把配置和数据塞在一个嵌套了很多层级的目录里。
> 3.1.0 起改为上面这套三段式结构，**升级时会自动迁移**，详见[从 1.x / 2.0 升级](user/migrate.md)。

## 生效方式

- 配置**只在插件启动时读取**；
- 改完用 `/ca reload`（简写 `/ca r`）重载，或重启服务器；
- 文件是**带注释的 JSON**，语法写错会读取失败，建议改完立刻 `/ca reload` 看日志。

## 配置项

### 基础

| 键 | 默认值 | 可选值 | 说明 |
|---|---|---|---|
| `enable` | `true` | true / false | 总开关，关闭后 CALL 不加载任何功能 |
| `permission` | `"op"` | `all` / `op` / `customize` | 谁能用；`customize` 时配合 `config/userlist.json` 白名单 |
| `consoleLanguage` | `"zh_CN"` | zh_CN / zh_TW / en_US / ru_RU | 控制台语言 |
| `debugMod` | `false` | true / false | 输出调试日志（形状包开发时用） |
| `displayLogo` | `true` | true / false | 启动时打印字符 Logo |
| `suvivalModeActive` | `true` | true / false | 生存模式相关限制（键名沿用原版拼写） |

### 选区显示

| 键 | 默认值 | 可选值 | 说明 |
|---|---|---|---|
| `areaDisplayMode` | `"wireframe"` | `wireframe` / `particle` / `text` / `structure_block` / `off` | 选区显示方式。`wireframe`（3.2.0 默认）通过 HologramLib 发线框包，**全服玩家可见、不写世界**；`structure_block` 是旧做法（临时结构方块，会写世界）；没装 HologramLib 时 `wireframe` 自动退回粒子框 |
| `areaTextTipInterval` | `1000` | 250 – 10000 | 选区尺寸文字提示的刷新间隔（毫秒） |
| `holoMaxRenderDistance` | `256` | 16 – 512 | 线框的最远渲染距离，超出后客户端不再绘制（省带宽） |

### 工具物品（3.2.0 新增）

| 键 | 默认值 | 可选值 | 说明 |
|---|---|---|---|
| `toolItems` | `true` | true / false | 是否安装并启用内置工具物品。关闭后不再复制物品包，物品自然不可用 |
| `previewTimeout` | `60` | 10 – 600 | 预览魔杖多久没操作就自动取消（秒） |

### 数量与上限

| 键 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `maxSaveStructure` | `30` | 0 – 200 | 每个玩家最多保存多少个结构 |
| `maxUndoStep` | `5` | 0 – 100 | 撤销 / 重做的最大步数 |
| `maxPlaceBlocks` | `40000` | 1000 – 200000 | **形状生成**单次最大方块数 |
| `maxRestoreBlocks` | `2000000` | 40000 – 20000000 | **撤销 / 重做 / 粘贴 / 载入**单次最大方块数（恢复类操作通常远大于形状生成） |
| `placeBatchBlocks` | `2000` | 50 – 5000 | 逐块写回时每批多少块后让出主线程；调小更平滑、调大更快 |
| `viewMaxDistance` | `150` | 1 – 300 | 视野选区的最远距离 |

### 区块加载与指令节奏

| 键 | 默认值 | 可选值 / 范围 | 说明 |
|---|---|---|---|
| `chunkLoader` | `"tickingarea"` | `tickingarea` / `none` | 用 `/tickingarea` 常加载区块（**不会移动玩家**）。设成 `none` 后远程大选区会失败 |
| `chunkLoadTimeout` | `15000` | 500 – 60000 | 等待区块加载 / 生成的超时（毫秒）。大选区首次需要生成新区块，太小时会失败 |
| `traversalWaitTime` | `300` | 0 – 10000 | 每个分片之间的间隔（毫秒） |
| `fillWaitTime` | `40` | 0 – 1000 | 填充时每条指令之间的间隔（毫秒） |

### 新玩家默认设置（`default` 对象）

`default` 决定新玩家第一次进服时的个人设置；进服后玩家可在菜单里自行修改（存于 `data/settings.json`）。

| 子键 | 默认值 | 说明 |
|---|---|---|
| `enable` | `true` | 是否启用该玩家的 CALL |
| `saveArea` | `false` | 复制时是否同时保存选区 |
| `saveUndo` | `true` | 是否保存撤销快照 |
| `saveCopy` | `false` | 是否保存复制内容 |
| `saveEntity` | `true` | 是否保存实体 |
| `areaTextShow` | `true` | 是否显示选区尺寸文字 |
| `displayArea` | `true` | 是否显示选区 |
| `displayProgressBar` | `true` | 是否显示进度信息（3.x 是文字提示，不再是 boss 条） |
| `loadChuckTip` | `true` | 加载区块时是否提示 |
| `textureSelectorMode` | `false` | 材质选区模式 |
| `barReplace` / `barReplaced` | `0` / `1` | 填充时的"替换前 / 后"行为（0–10） |

## 已废弃的键

下列键**仍存在于配置文件中**（兼容 1.x 旧文件），但 **3.x 代码不会读取**，改了没有效果；可以保留也可以自行删除。

| 键 | 原用途 | 现状 |
|---|---|---|
| `autoUpdate` | 自动更新插件 | 2.0 起移除自动更新 |
| `updateFrom` | 自动更新的下载源（github / minebbs） | 同上 |
| `maxLoadCheckNum` | 旧的区块加载重试次数 | 已由 `chunkLoadTimeout` 取代 |

?> 原版文档还提到 `oldCommandType`、`outputCmd` —— 这两个键在 3.x 里完全不存在，写进去会被忽略。

## 改错了怎么办

- 只是值写错：按上表填回默认值，然后 `/ca reload`；
- 文件解析不了：删掉 `plugins/CALL/assets/configs.json` 后重启，插件会从内置模板重新生成默认配置（覆盖配置项本身，玩家数据与结构文件不受影响）。
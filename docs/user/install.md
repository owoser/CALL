# 安装说明

## 环境要求

| 组件 | 版本要求 | 说明 |
|---|---|---|
| 服务端 | **Bedrock Dedicated Server 1.26.51 及以上** | 26.51 与 26.60 均实测可用 |
| 加载器 | **LeviLamina 26.51.9 及以上** | 旧称 LiteLoaderBDS，LL3 是大版本分界 |
| 脚本引擎 | **legacy-script-engine-nodejs 0.22.3 及以上** | CALL 是 LSE 的 Node.js 插件（`type: lse-nodejs`）；0.22.3 / 0.22.4 均实测可用 |
| 前置库 | **[HologramLib](https://github.com/Ieckseyr/HologramLib) 26.51.11+ / 26.60.8+** | 线框、假方块预览（含方块状态与方块实体）与"对空左键"依赖它；**缺失时只降级这几项**，选区/复制/粘贴/填充照常可用。CALL 按**导出面**判定能力（需要 450 条导出），不认发布号 |

!> 版本不匹配只会让加载失败或给出警告，不会静默损坏数据。启动日志里 CALL 会打印检测到的 BDS / LSE 版本。

!> **内置工具物品与引擎版本**：物品定义用的是 `format_version 1.21.40`，比 1.26.51 / 1.26.60 都旧，引擎会自动升级旧文档；反过来（文档比引擎新）会被直接丢弃，日志里表现为 `[Json] ... document's version is out of handled range`，物品包看起来“装了但没生效”。

## 前置库 HologramLib

CALL 的**预览**（假方块、方块状态、方块实体）与**选区线框**由 HologramLib 提供原语，所以它是前置库。

| 项 | 地址 |
|---|---|
| 仓库 | <https://github.com/Ieckseyr/HologramLib> |
| 文档 | <https://ieckseyr.github.io/HologramLib/> |
| 下载 | <https://github.com/Ieckseyr/HologramLib/releases> |
| 问题反馈 | <https://github.com/Ieckseyr/HologramLib/issues> |

### 选哪个包

按你的平台线选**对应的发布包**（CALL 按**导出面**判定能力，需要 450 条导出）：

| 平台线 | 发布包 |
|---|---|
| BDS 1.26.51 / LL 26.51.x | `LeviLamina-HologramLib-26.51.11.zip` |
| BDS 1.26.60 / LL 26.60.x | `LeviLamina-HologramLib-26.60.8.zip` |

### 安装方式

**方式一：lip（推荐）**

```text
lip install github.com/Ieckseyr/HologramLib
```

**方式二：手动**

1. 关服；
2. 解压发布包，得到 `HologramLib/` 文件夹（内含 `HologramLib.dll`、`lib/`、`manifest.json`）；
3. 把这个文件夹整体放进服务端的 **`mods/`**（LL3 的 `plugins/` 同样会被加载），最终为：
   ```text
   <服务器根目录>/mods/HologramLib/HologramLib.dll
   ```
4. 开服；启动顺序无要求（库会在 `ServerStarted` 兜底重试）。

### 验证装好了

CALL 启动时会在控制台打印检测结果：

```text
[CALL] HologramLib 26.51.11 (ABI 1.37.0 / LSE 1.0.0 · 450 exports) — 状态✓ 批量✓ 方块实体✓ 粘贴同步✓ swing✓
```

游戏内也可以 `/ca tools debug` 看能力行。

### 没装 / 版本不匹配会怎样

不会崩，也不会静默改行为：**预览与选区线框降级**（预览只剩最基本的假方块或直接提示不可用），
选区 / 复制 / 粘贴 / 填充 / 撤销**照常可用**，控制台会给出一次明确告警。

## 安装步骤

1. **装好 LL3 与 LSE（nodejs 版）**，确认服务器能正常启动，控制台能看到 LeviLamina 与 LegacyScriptEngine 的加载日志；
2. **装好前置库 HologramLib**（预览与选区线框依赖它，见上面「前置库 HologramLib」一节）；
3. **下载发布包**：[GitHub Releases](https://github.com/owoser/CALL/releases/latest) 里的 `CALL-<版本>.zip`；
4. **解压到插件的 `plugins` 目录**，解压后应当是：

   ~~~text
   <服务器根目录>/
     bedrock_server_mod.exe
     plugins/
       CALL/                    ← 目录名必须正好是 CALL
         manifest.json
         index.js
         package.json
         core/                  程序
         assets/                只读资源（语言包、图标、导入导出工具）
         config/                你的配置
         data/                  你的数据
         node_modules/          ← 首次启动时由 LSE 自动安装
   ~~~

5. **重启服务器**。

!> **目录名必须是 `CALL`（区分大小写）**。
LL3 要求插件目录名与 `manifest.json` 里的 `name` 完全一致，否则会报"模组名称 CALL 与文件夹 xxx 不匹配"并拒绝加载。

## 怎么确认装好了

启动完成后，控制台应当出现：

~~~text
[CALL] LegacyScriptEngine ... 版本提示（若过低会警告）
[CALL] [CALL][command] /call registered (alias: /ca)
[CALL] 4.0.0 ready (root: <你的路径>/plugins/CALL)
[CALL] config: <你的路径>/plugins/CALL/assets/configs.json
~~~

然后进游戏输入 `/ca help` 能看到菜单即可。

## 首次启动会生成什么

| 路径 | 内容 |
|---|---|
| `plugins/CALL/node_modules/` | 运行时依赖，**由 LSE 自动执行 `npm install --omit=dev` 安装**（首次启动会慢一点，需要能访问 npm 源） |
| `plugins/CALL/config/configs.json` | 全局配置（带注释，见[配置参考](user/config.md)） |
| `plugins/CALL/config/userlist.json` | 白名单（`permission` 为 `customize` 时使用） |
| `plugins/CALL/config/permission.json` | 按文件维护的白名单 |
| `plugins/CALL/data/settings.json` | 玩家个人设置 |
| `plugins/CALL/data/structures.json` | 玩家结构索引 |
| `plugins/CALL/data/nbt/` | 结构切片文件（`.mcstructure`） |
| `plugins/CALL/data/shapes/` | 第三方形状包 |
| `plugins/CALL/data/import` / `export` | 导入 / 导出暂存 |

### 内置工具物品的包（3.2.0 新增）

插件自带一套 addon（`assets/addon/CALL_Tools_BP` + `CALL_Tools_RP`），首次启动会：

1. 复制到 `<服务器>/behavior_packs/` 与 `resource_packs/`；
2. 合并写入世界的 `world_behavior_packs.json` / `world_resource_packs.json`（**不会覆盖**你已有的包，改前会备份 `.bak`）；
3. 控制台提示 **"重启服务器后生效"** —— 真的需要重启一次，之后会打印 `[CALL] tool items ready`。

不想用自定义物品就把 `configs.json` 里的 `toolItems` 设为 `false`，插件不会再碰你的包目录。

### 离线服务器怎么办

本插件的依赖由 LSE 在首次启动时安装。**服务器不能访问 npm 源时**：

- 用发布页里的 **`CALL-<版本>-full.zip`**（已内置 `node_modules`），或
- 在插件目录手动执行 `npm install --omit=dev`。

## 从旧版本升级

**直接覆盖** `plugins/CALL` 里的程序文件即可，**不要**删除 `userdata` —— 配置、玩家设置、已保存的结构都在里面，格式与 1.x 完全兼容。

详见[从 1.x / 2.0 升级](user/migrate.md)。

## 卸载

删除 `plugins/CALL` 整个目录即可。`userdata` 里的结构文件是普通文件，需要保留的话先备份出来。
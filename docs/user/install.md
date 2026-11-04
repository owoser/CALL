# 安装说明

## 环境要求

| 组件 | 版本要求 | 说明 |
|---|---|---|
| 服务端 | **Bedrock Dedicated Server 1.26.51** | 官方基岩版专用服务器 |
| 加载器 | **LeviLamina 26.51.9 及以上** | 旧称 LiteLoaderBDS，LL3 是大版本分界 |
| 脚本引擎 | **legacy-script-engine-nodejs 0.22.4 及以上** | CALL 是 LSE 的 Node.js 插件（`type: lse-nodejs`） |

!> 版本不匹配时会直接加载失败。启动日志里 CALL 会打印当前检测到的 BDS / LSE 版本，低于最低要求会给出警告。

## 安装步骤

1. **装好 LL3 与 LSE（nodejs 版）**，确认服务器能正常启动，控制台能看到 LeviLamina 与 LegacyScriptEngine 的加载日志；
2. **下载发布包**：[GitHub Releases](https://github.com/owoser/CALL/releases/latest) 里的 `CALL-<版本>.zip`；
3. **解压到插件的 `plugins` 目录**，解压后应当是：

   ~~~text
   <服务器根目录>/
     bedrock_server_mod.exe
     plugins/
       CALL/                    ← 目录名必须正好是 CALL
         manifest.json
         index.js
         core/
         config/
         userdata/
         node_modules/
   ~~~

4. **重启服务器**。

!> **目录名必须是 `CALL`（区分大小写）**。
LL3 要求插件目录名与 `manifest.json` 里的 `name` 完全一致，否则会报"模组名称 CALL 与文件夹 xxx 不匹配"并拒绝加载。

## 怎么确认装好了

启动完成后，控制台应当出现：

~~~text
[CALL] LegacyScriptEngine ... 版本提示（若过低会警告）
[CALL] [CALL][command] /call registered (alias: /ca)
[CALL] 3.0.7 ready (root: <你的路径>/plugins/CALL)
[CALL] config: <你的路径>/plugins/CALL/userdata/config/configs.json
~~~

然后进游戏输入 `/ca help` 能看到菜单即可。

## 首次启动会生成什么

| 路径 | 内容 |
|---|---|
| `plugins/CALL/userdata/config/configs.json` | 全局配置（带注释，见[配置参考](user/config.md)） |
| `plugins/CALL/userdata/data/settings.json` | 玩家个人设置 |
| `plugins/CALL/userdata/data/structures.json` | 玩家结构索引 |
| `plugins/CALL/userdata/data/nbt/` | 结构切片文件（`.mcstructure`） |
| `plugins/CALL/userdata/plugins/` | 第三方形状包目录 |

## 从旧版本升级

**直接覆盖** `plugins/CALL` 里的程序文件即可，**不要**删除 `userdata` —— 配置、玩家设置、已保存的结构都在里面，格式与 1.x 完全兼容。

详见[从 1.x / 2.0 升级](user/migrate.md)。

## 卸载

删除 `plugins/CALL` 整个目录即可。`userdata` 里的结构文件是普通文件，需要保留的话先备份出来。

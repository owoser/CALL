# 问题反馈

## 提交 Issue

请到 **<https://github.com/owoser/CALL/issues>** 提交，并尽量附上下面这些信息，能显著加快定位：

1. **版本信息**：`/ca help` 或启动日志里的 `[CALL] x.y.z ready` 一行
2. **运行环境**：BDS 版本、LeviLamina 版本、LegacyScriptEngine 版本
3. **复现步骤**：做了什么操作、选区多大、在哪个维度
4. **日志**：`logs/latest.log` 里报错前后的片段（不要只贴一句）
5. **崩溃转储**：如果服务端直接挂了，附上 `logs/crash/` 里最新的 dump 文件名
6. **`debugMod` 诊断日志**：坐标、点击、预览相关的问题，请先把配置里的 `debugMod` 打开复现一次，
   附上 `[CALL]` 前缀的日志行（例如 `[CALL][tool] … posf=… side=…`、`[CALL][area] … stored=…`）。
   这些日志默认**不打印**，不附日志基本无法定位。

## 先区分两种"掉线"

| 现象 | 判断依据 | 性质 |
|---|---|---|
| 客户端断开，**服务端还在跑** | 日志里玩家离开，进程存活，`logs/crash/` 没有新文件 | 客户端侧断开（多见于旧版的 boss 条问题，3.x 已移除） |
| 服务端进程消失 | 有 `logs/crash/*.dmp`，或终端直接退出 | 服务端崩溃，需要看 dump |

3.x 已经移除了会踢客户端的 boss 条调用；如果你在 3.0.7 上仍然遇到"填充时客户端掉线"，请务必附上 **断开那几秒的完整日志**。

## 提交前可以先自查

- 是不是选了超出 `maxRestoreBlocks` / `maxPlaceBlocks` 的区域？（日志会明确写出来）
- 是不是 `chunkLoader` 被设成了 `none`？
- 服务端是不是还没装 LSE（nodejs 版）？
- 目录名是不是正好是 `CALL`？

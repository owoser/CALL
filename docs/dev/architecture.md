# 架构与平台坑

?> 面向想改代码或写形状包的人。这份文档存在的唯一目的：**别再踩一遍已经踩过的坑**。

所有结论都在 **LeviLamina 26.51.x + LegacyScriptEngine 0.22.x** 上实测验证过（~`~npm run test:unit~`~ / ~`~npm run test:live~`~）。

## 五条铁律

1. **绝不调用 ~`~mc.setStructure~`~**
2. **绝不把未校验的值塞进数据包**（尤其是 boss 条颜色）
3. **绝不缓存 ~`~Player~`~ 句柄**
4. **绝不为了加载区块而传送玩家**
5. **每个引擎回调都过 ~`~util/Safe.ts~`~**（~`~safeCall~`~ / ~`~runAsync~`~）

## 1. ~`~mc.setStructure~`~ 会让服务端崩溃

| 调用 | 结果 |
|---|---|
| ~`~mc.getStructure(pos1, pos2)~`~ | ✅ 正常，NBT 正确 |
| ~`~mc.setStructure~`~（引擎抓的 NBT） | ❌ 静默不生效 |
| ~`~mc.setStructure~`~（手工构造的模板） | 💥 **访问违例 0xC0000005**，进程直接死，所有玩家掉线 |

CALL 的做法：

- **抓取**：~`~mc.getStructure~`~ → 存成 ~`~.mcstructure~`~ 到 ~`~userdata/data/nbt~`~；
- **还原**：~`~core/src/io/NbtCodec.ts~`~ 解析字节，~`~StructurePlacement.placeLayoutAsync~`~ 逐块 ~`~Block.setNbt()~`~，每 ~`~placeBatchBlocks~`~ 块让出一次；
- **变换**：镜像/旋转在 ~`~transformLayout~`~ 里提前改写索引（游戏端根本收不到旋转参数）。

## 2. 结构索引是 **ZYX 顺序**

官方 ~`~.mcstructure~`~ 规范：

~~~text
index -> coords:  (i / SZ / SY, i / SZ % SY, i % SZ)
coords -> index:  SZ*SY*X + SZ*Y + Z      // Z 变化最快
~~~

3.0.0 用了"Y 变化最快"，结果**每一个粘贴出来的结构都被转置**（竖墙变平铺）。实现见 ~`~core/src/io/StructureOrder.ts~`~，单元测试按规范钉死。

## 3. 客户端可见的值必须校验

~`~Player.setBossBar(uid, title, percent, colour)~`~ 在 LSE 里是：

~~~cpp
BossBarColor color = static_cast<BossBarColor>(args[3].toInt32()); // 无校验
pkt->mColor = color;                                              // 直接发给客户端
~~~

而 ~`~BossBarColor~`~ 是 ~`~enum class : uchar~`~，只有 **0..7**。1.x 传了 **11** → 客户端收到越界枚举 → **掉线**（服务端还活着）。这就是"填充就掉线、复制粘贴却没事"的原因。

- 进度已全部改为文字提示；
- ~`~core/src/game/SafeArgs.ts~`~ 对颜色、百分比、消息类型、维度、Y 全部做范围校验。

## 4. 玩家句柄要现取，不能缓存

~`CAPlayer.$~`~ 是 getter，每次访问都走 ~`~mc.getPlayer(xuid)~`~。缓存过的 ~`~Player*~`~ 在玩家重连后就是悬垂指针，读 ~`.realName~`~ / ~`.langCode~`~ 会直接崩。

## 4.5 NbtCompound 只接受 NbtTag 对象

`new NbtCompound({...})` 的每个值都必须是 `NbtInt` / `NbtString` 这样的 **NBT 对象**，
塞纯 JS 数字或字符串会抛 `Wrong Type of data to set into NBT Compound!`。

3.0.7 就栽在这里：`NbtCodec` 把 palette 的 states 解析成纯 JS 值，写回时直接塞进 compound →
**凡是带状态的方块（楼梯、台阶、原木、栅栏…）粘贴与撤销全部整片失败**。

修法：`StructureLayout.palette[].states` 保留原始 NBT tag id（`NbtTypedValue`），写回时按类型重建
`NbtByte` / `NbtInt` / `NbtLong` / `NbtFloat` / `NbtDouble` / `NbtString`；单个状态重建失败只丢那一个。

!> 教训：真机用例必须包含**带状态**的方块。3.0.0–3.0.7 的用例全是 stone / gold / diamond
这种无状态方块，所以这个明显的问题活了七个版本。

## 5. 加载区块不要传送玩家

1.x/2.0 靠传送玩家把区块拽过来（~`~loadChunk~`~ 每 400ms、~`~tpAsync~`~ 每 50ms 传一次）。

~`~core/src/game/Chunks.ts~`~ 用命名 ~`~/tickingarea~`~，**租约制**：

1. ~`~acquire(area)~`~ 拿到租约（引用计数，按区域复用）；
2. 轮询确认整片区域可读；
3. 整个分片处理完才 ~`~release()~`~，最后一个引用释放时才真正删除；
4. 启动时清扫上次残留的 ~`~call_*~`~（BDS 全局上限只有 **10 个**常加载区域）。

!> **坑**：~`~mc.getBlock~`~ 会按需加载区块，所以"能读到"**不等于** ~`~/fill~`~ 能执行。
~`~acquire~`~ 因此不信任可读性探测，一律真的申请常加载区域；命令失败时还会重试。

## 6. 指令层

~`~core/src/game/Cmd.ts~`~ 是唯一与指令系统打交道的地方：

| 函数 | 用途 |
|---|---|
| ~`~run(cmd)~`~ | 控制台指令，下一 tick 执行 |
| ~`~runNow(cmd)~`~ | 控制台指令，立即执行 |
| ~`~runAs(player, cmd)~`~ | ~`~Player.runcmd~`~，不做玩家名插值 |
| ~`~fillCommand / cloneCommand / structureCommand / teleportCommand~`~ | 校验过的指令构造器 |

注意：

- BDS 把"**0 个方块已填充**"当作**失败**返回，CALL 视为正常空操作；
- ~`~/fill~`~ 单条上限 32768 块，所以按 ~`~slabHeight()~`~ 动态切片（目标 30000，留余量）。

## 7. 原生 ~`~/structure load~`~ 用不了（已实测排除）

| 方案 | 结果 |
|---|---|
| 文件放 ~`~<bds>/structures/~`~ | ❌ ~`~找不到 mystructure:xxx 结构~`~ |
| 文件放 ~`~structures/mystructure/~`~ | ❌ 同样失败 |
| 世界存档里的结构 | 存在 LevelDB 中，只有 ~`~/structure save~`~ 自己写进去的才能 load |

所以逐块写回必须保留。

## 8. 测试分层

| 层 | 命令 | 覆盖 |
|---|---|---|
| 单元 | ~`~npm run test:unit~`~ | NBT 编解码（真实结构文件）、轴序、镜像旋转、参数校验，不需要服务器 |
| 真机 | ~`~npm run test:live~`~ | 真服务器上跑真实指令路径：填充、清空、复制粘贴、撤销、选区显示、区块租约 |
| 目视 | 手工清单 | 选区框、GUI、工具键位、客户端是否掉线 |

!> 真机测试**必须走真实指令路径**。2.0 的 16 项测试全绿，但 ~`~/ca fill~`~ 仍然会踢客户端 —— 因为那些测试只直接调用模块。
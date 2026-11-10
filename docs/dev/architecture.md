# 架构与平台坑

?> 面向想改代码或写形状包的人。这份文档存在的唯一目的：**别再踩一遍已经踩过的坑**。

所有结论都在 **LeviLamina 26.51.x + LegacyScriptEngine 0.22.x** 上实测验证过（~`~npm run test:unit~`~ / ~`~npm run test:live~`~）。

## 七条铁律

1. **绝不调用 ~`~mc.setStructure~`~**
2. **绝不把未校验的值塞进数据包**（尤其是 boss 条颜色）
3. **绝不缓存 ~`~Player~`~ 句柄**
4. **绝不为了加载区块而传送玩家**
5. **每个引擎回调都过 ~`~util/Safe.ts~`~**（~`~safeCall~`~ / ~`~runAsync~`~）
6. **位置参数一律 ~`~Vec3~`~ + ~`~Math.floor~`~**——LSE 返回的是方块**中心**，见第 9 节
7. **预览用 ~`~viewBlock~`~ / ~`~blockBatch*~`~，不用 item display**，见第 10 节

## 1. ~`~mc.setStructure~`~ 会让服务端崩溃

| 调用 | 结果 |
|---|---|
| ~`~mc.getStructure(pos1, pos2)~`~ | ✅ 正常，NBT 正确 |
| ~`~mc.setStructure~`~（引擎抓的 NBT） | ❌ 静默不生效 |
| ~`~mc.setStructure~`~（手工构造的模板） | 💥 **访问违例 0xC0000005**，进程直接死，所有玩家掉线 |

CALL 的做法：

- **抓取**：~`~mc.getStructure~`~ → 存成 ~`~.mcstructure~`~ 到 ~`~data/nbt~`~；
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

## 9. 坐标语义：LSE 的位置参数是方块**中心**

这是本仓库代价最大的一次误判（"所有工具都往左偏一格"，连续排查了八轮）。

LegacyScriptEngine 把位置参数回传为**方块中心**（~`~x + 0.5~`~），而 ~`~ParamType.BlockPos~`~ 在转成整数时是**向零截断**而不是向下取整：

| 点击的方块 | 回传值 | ~`~BlockPos~`~ 截断 | ~`~Vec3~`~ + ~`~Math.floor~`~ |
|---|---|---|---|
| x = 44 | 44.5 | 44 ✅ | 44 ✅ |
| x = -44 | -43.5 | -43 ❌ | -44 ✅ |
| x = -0.5 | 0.5 | 0 ❌ | 0 ✅ |

所以**正坐标看起来正常、负坐标必偏一格**，而且在世界里"往负方向就是偏一格"，很容易被误判成线框或渲染问题。

CALL 的做法（~`~core/src/CACommand.ts~`~ 的 ~`~normalisePositions~`~）：

- 命令参数一律声明为 ~`~ParamType.Vec3~`~；
- 回调第一步把 ~`~intPos~ / ~IntPos~ / ~AxisPos~`~ 全部 ~`~Math.floor~`~；
- 事件侧另有两条约定：~`~player.pos.y~`~ 是**脚部格**，"脚下那个方块"要向下扫到第一个非空气块；
  ~`~${posf}~`~ 是**点击面平面**（点 +Z 面会多一格），需要原始点用 ~`~${hitf}~`~。

!> 判断修没修好，不要看截图：开 ~`~debugMod~`~ 让日志打印解析后的 IntPos，点 ~`~-45~`~ 的方块必须打印 ~`~-45~`~。

## 10. 预览与假方块：选型、顺序、预算

| 手段 | 性质 | 适用 |
|---|---|---|
| ~`~viewBlock~`~/~`~viewClearBlock~`~ | 纯客户端方块覆盖，无实体 | 单格、小范围预览（首选） |
| ~`~blockBatch*~`~ | 同上，但按子区块合并成 UpdateSubChunkBlocks | 大范围；≤1024 格/包，库全局 8 包/刻 |
| item display | **伪实体**（一个浮空实体装着方块） | 不用于预览：会"随风飘扬"、慢、卡 |

三条硬顺序：

1. **先清理再下发**：~`~diffPlacement~`~ 必须先发 clear 再发 set，否则"移动"会先画出新窗口再还原旧窗口；
2. ~`~applied~`~ 是"客户端此刻显示着什么"的唯一记忆，**不可整体清空**，未确认的清理要进 ~`~stale~`~ 重试；
3. 线框**不要设时长**：~`~shapeSetDuration~`~ 在部分版本上会留下"幽灵计时实体"，尺寸不变时用 ~`~shapeSetLocation~`~ 移动而不是重建。

### 实测：方块状态只有 network id / SNBT 这条路过关

在 HologramLib 26.60.8 上逐项量过（同一个楼梯，只改朝向）：

| 调用 | 结果 | 结论 |
|---|---|---|
| `blockFakeResolve('minecraft:stone_stairs[weirdo_direction=2,…]')` | 3265450305 | 与下一行**相同** |
| `blockFakeResolve('minecraft:stone_stairs[weirdo_direction=0,…]')` | 3265450305 | 状态串解析是**按名字查基态**，状态被忽略 |
| `blockFakeResolveNbt('{"name":"minecraft:stone_stairs","states":{"weirdo_direction":2,…}}')` | 3142500659 | **吃状态** |
| `blockFakeResolveNbt('…"weirdo_direction":0…')` | 3265450305 | 与基态一致 |

所以 `blockFakeSet` / `blockBatchSet` 画的楼梯永远是默认朝向（它们都走状态串解析），这也是
"预览楼梯朝向不对、粘贴却正常"的最终根因。CALL 现在的画法是两层：

1. **批量铺本体**（`blockBatchSet`，快，但只有基态）；
2. **状态叠加**：palette 里带状态的格子用 `blockFakeResolveNbt` 求出 network id，再用
   `viewBlockById` 覆盖一次（每个预览上限 2048 格，超出部分保留基态并在计数里体现）。

**旋转必须重映射状态**：`transformLayout()` 只重排索引网格，palette 原样带走，所以早期版本"形状转了、楼梯朝向没转"。
现在由 ~`~StateRemap.remapStates()~`~ 统一处理方向性状态（~`~weirdo_direction~`~ / ~`~cardinal_direction~`~ /
~`~facing_direction~`~ / ~`~torch_facing_direction~`~ / ~`~pillar_axis~`~ / ~`~ground_sign_direction~`~），粘贴与预览共用同一张表；
表里没有的键（如 ~`~direction~`~）**保持原值**，确认语义后再加，不猜。

**批量是排队的，即时写会被它覆盖**：一批超过 ~`~previewBatchImmediate~`~（默认 256）就会进库的队列、按 tick 分帧下发；
紧跟着的 ~`~blockFakeSetNbt~`~/~`~blockFakeSetBlockEntity~`~ 是立即发包，会被后到的**基态**方块覆盖（表现为"状态发送成功但朝向不对""实体数据发送成功但旗帜黑"）。
所以带状态、带方块实体的格子**不参与批量**，由逐格路径一次写对。

**SNBT 必须自己序列化**：LSE 的 `toLseTag().toSNBT()` 在"列表里套复合标签"（旗帜 `Patterns`）时返回**空串**，
箱子那种空列表却正常——这条曾被误读成"复制没抓到方块实体"。现在由 ~`~NbtCodec.snbtWrite()~`~ 直接产出 SNBT（键不加引号），
粘贴写入用 ~`~NBT.parseSNBT(snbtOf(...))~`~，`toLseTag` 只做兜底。

**两族覆盖接口不可混用**：~`~blockFake*~`~ 发的是普通方块更新包（teardown 重发真实方块即可清除），
~`~view*~`~ 写的是**按玩家持久注册表**（区块重载、重登后仍生效，只能 ~`~viewClearBlock~`~/~`~viewClearAll~`~ 删）。
同一次预览混用两族，就会出现"取消后残留半截、重登才干净"。CALL 现在全程只用 ~`~blockFake*~`~。

另外两个坑：状态串的**键不能加引号**（库只给值去引号，`["k"=v]` 整条被拒）；`blockFakeSet`
要求**真实在线玩家**（`level->getPlayer`），所以无头测试只能断言解析结果，不能断言"发送成功"。

版本闸门（~`~core/src/holo/HoloCompat.ts~`~）：能力按**导出面**判定，最低 v26.51.11 / v26.60.8（450 导出）：

| 能力 | 最低版本 | 说明 |
|---|---|---|
| ~`~swingCount~`~（对空左键） | API 1.37.0 / LL 26.51.9 · 26.60.5 | 26.51.8 是另一套已撤回接口 |
| ~`~shapeDestroy~`~ 真正移除 | LL 26.51.10 · 26.60.6 | 更早版本要 park 到远处再销毁 |

低于最低版本时**只降级 + 告警一次**，不崩、不静默改变行为。

血条（~`~core/src/holo/BossBar.ts~`~）：

- 每次预览用**独立 id**，结束必须移除自己的 id，绝不调用"移除全部"；
- 参数按库要求传（id 这类大数要按大数传，否则控制台会刷 ~`~bossBarGetInfo: 参数类型不匹配~`~）。
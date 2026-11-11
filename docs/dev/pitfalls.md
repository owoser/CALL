# 真机踩坑台账

?> 用法：先在下面的"症状"里搜现象，再看根因与验证方式。改完把新坑追加到对应类别，并在验证一列写清**怎么证明它真的修好了**。

本台账每一条都能在源码注释里找到对应说明；机制与实测数据见 [架构与平台坑](dev/architecture.md)。

## A. 平台 API

| # | 症状 | 根因 | 修法 | 怎么验证 | 代码位置 |
|---|---|---|---|---|---|
| A1 | 粘贴/生成时服务端直接崩、全服掉线；或调用成功但世界没变化 | `mc.setStructure` 对引擎抓的 NBT 静默无效，对手工模板触发访问违例 | 抓取只用 `mc.getStructure`；还原走 NbtCodec 解析 + 逐块 `setNbt` | `npm run test:live` 的 copy→paste 用例；进程不退出 | `core/src/structure/StructurePlacement.ts` |
| A2 | 粘贴出来的结构"放倒"：竖墙变平铺、扁平选区变高箱 | 结构索引轴序是 ZYX（Z 变化最快）；3.0.0 写成 Y 最快 | 统一走 `cellIndex` / `cellCoords` | `npm run test:unit` 轴序用例；对照官方 .mcstructure 规范 | `core/src/io/StructureOrder.ts` |
| A3 | 带状态的方块（楼梯/台阶/原木/栅栏/旗帜）粘贴或撤销时整片失败，日志 `Wrong Type of data to set into NBT Compound!` | `NbtCompound` 只接受 NbtTag 对象，塞纯 JS 值会抛 | palette 的 states 保留原始 tag 类型，写回时按类型重建 | 用例必须含带状态方块；粘贴后看朝向 | `core/src/io/NbtCodec.ts` |
| A4 | 较大的结构文件解析失败 / 原生 `/structure load` 说找不到 | LSE 产出的是 BE 网络 NBT，结构文件要 LE | 一律经 NbtCodec 转码 | 读一个真实结构文件做往返 | `core/src/io/NbtCodec.ts` |
| A5 | `/ca fill` 一执行客户端就掉线，但服务端还在跑 | 血条颜色 11 越界（枚举只有 0..7） | 所有出站枚举/数值走 `SafeArgs` 夹取 | fill / clear / replace 各跑一次都不掉线 | `core/src/game/SafeArgs.ts` |

## B. 坐标与交互语义

| # | 症状 | 根因 | 修法 | 怎么验证 | 代码位置 |
|---|---|---|---|---|---|
| B1 | 选点/预览/粘贴整体偏一格，负坐标区域必现 | **LSE 位置参数是方块中心（x+0.5）**，`ParamType.BlockPos` 向零截断 | 参数声明 `Vec3`，回调里 `Math.floor` | `debugMod` 下打印 IntPos 与真实方块；`-44` 必须存成 -44 | `core/src/CACommand.ts` |
| B2 | 绑定写 `${posf.x}` 会选到邻块 | posf 是点击**面**平面（+Z 面会多一格） | 迁移把 `${posf.*}` 改写为 `${pos.*}`；需要原始点才用 `${hitf}` | 单测覆盖迁移；日志对比 posf/pos | `core/src/user/BindingMigration.ts` |
| B3 | 空气点击取点落在头顶/身体格 | `player.pos.y` 是脚部格，且 `getBlockStandingOn` 在本构建返回脚部格 | 向下扫描最多 3 格，取第一个非空气块 | 站在 y=38 点空气应得到 y=37 的方块 | `core/src/structure/AreaOperation.ts` |
| B4 | 生成形状/粘贴后玩家被"传送"到别处 | 旧实现靠传送玩家加载区块 | tickingarea 租约，不移动玩家 | 无人在旁的区域 fill 成功且玩家不动 | `core/src/game/Chunks.ts` |
| B5 | 偶发"工具未绑定"，或没点击却触发预览 | 绑定只按类型匹配、一次点击被重复消费 | 类型 + 显示名双匹配（空名视为无自定义名）；一次点击只路由一次 | 反复切工具点空气，日志无重复路由 | `core/src/user/Bindings.ts`、`ToolItems.ts` |

## C. HologramLib 集成

| # | 症状 | 根因 | 修法 | 怎么验证 | 代码位置 |
|---|---|---|---|---|---|
| C1 | 假方块像实体一样"随风飘扬"、中大型建筑掉帧、方块显示不全 | 用了 item display（伪实体）而不是 `viewBlock` | 预览改用 `viewBlock`；大批量走 `blockBatch*` | 1 万格以上预览：不抖动、帧率稳定 | `core/src/holo/BlockView.ts`、`FakeBlocks.ts` |
| C2 | 预览移动/取消后客户端残留方块，重进才消失 | 先 set 后 clear；`applied` 被整体清空；清理失败未重试 | clears-before-sets；`applied` 只增删对应项；未确认清理进 `stale` 重试 | 连续移动/取消 20 次，取消后无残留 | `core/src/structure/PreviewScene.ts`、`GhostLedger.ts` |
| C3 | 选区/预览线框越点越多、重复堆叠 | 尺寸不变也重建形状；形状设了 ttl（库版本行为差异） | 尺寸不变就 `shapeSetLocation`；不设 ttl；销毁走 park + destroy | 连续移动 10 次，客户端只有一个框 | `core/src/holo/Wireframe.ts` |
| C4 | 控制台刷 `bossBarGetInfo: 参数类型不匹配（实际传入 variant#1）` | 传了超出 i32 的 id / 参数类型不对 | id 按大数传；只按名称调用 | `debugMod` 下预览倒计时不刷错误 | `core/src/holo/BossBar.ts` |
| C5 | 倒计时不动、结束后不消失、第二次预览立刻结束 | 多次预览共用同一 bossbar id、状态未清 | 每次预览独立 id，结束必移除自己的 id | 连续 3 次预览，倒计时各自正常 | `core/src/holo/BossBar.ts`、`PreviewOperation.ts` |
| C6 | 左键（尤其对空气）没反应 | LSE 事件只上报点方块/点实体；看不到对空挥动 | `SwingWatcher` 轮询库的 swing 计数，100ms 去重 | 飞行中对空左键能设点 | `core/src/user/SwingWatcher.ts`、`HoloCompat.ts` |
| C7 | 升级库后线框/假方块行为变了（销毁不生效等） | 库版本差异 | `HoloCompat` 版本闸门；低于最低版本只降级 + 告警一次 | 启动日志显示库版本与能力状态 | `core/src/holo/HoloCompat.ts` |
| C8 | 预览里楼梯朝向、旗帜图案与实际粘贴不一致 | 预览没有还原 block states / 图案 NBT | 状态走 SNBT→network id + `viewBlockById`；图案走 `blockFakeSetBlockEntity` | `/ca tools debug` 看 `blockFakeResolve` 与 `blockFakeResolveNbt` 的 id 是否不同 | `core/src/structure/SurfaceExtract.ts`、`PreviewScene.ts` |
| C9 | 带状态方块串"格式正确"却被库整条拒绝（`blockFakeSet` 返回 false） | 库解析器只给**值**去引号，键不去引号：`["k"=v]` 里带引号的键查不到 | 状态串的键必须裸写：`[k=v]` | `blockFakeResolve` 返回 ≥0 | `core/src/structure/SurfaceExtract.ts` |
| C10 | 预览楼梯永远朝北，粘贴却正常 | `blockFakeSet`/`blockBatchSet` 走状态**串**解析 = 按名字查基态（26.60.8 实测：dir=2 与 dir=0 同 id） | 带状态的格子用 `blockFakeResolveNbt`(SNBT) 求 id 再 `viewBlockById` 覆盖 | 两个方向的 `blockFakeResolveNbt` 必须给出不同 id | `core/src/holo/BlockView.ts`、`PreviewScene.ts` |
| C11 | 粘贴后旗帜是纯色/黑色，重进才正常 | 服务端写对了（`getBlockEntity().setNbt`），但客户端没收到 BlockActorData | 写入后对附近玩家 `blockFakeSetNbt`(本体) + `blockFakeSetBlockEntity`(数据)，本体先行 | 粘贴后立即看到图案；`/ca tools debug` 里同步计数增长 | `core/src/holo/PasteSync.ts`、`StructurePlacement.ts` |

## D. 性能与规模

| # | 症状 | 根因 | 修法 | 怎么验证 | 代码位置 |
|---|---|---|---|---|---|
| D1 | 5 万格以上预览卡死、加载很慢 | 逐格下发 | `blockBatch*` + `BatchSender`（≤1024 格/包、8 包/刻） | 大选区移动时 MSPT 不爆、日志有批次数 | `core/src/structure/BatchSender.ts` |
| D2 | 控制台被 `+N 批 / +M 格` 刷屏 | 日志没归 `debugMod` | 周期日志一律 `debugMod` 才输出 | 关掉 `debugMod` 后无周期日志 | `core/src/structure/PreviewOperation.ts` |
| D3 | 超大区域清空/填充报"结构过大无法逐块放置" | 单次放置体积保护 | 分片 + 上限保护，并在游戏内提示范围 | 大选区得到明确提示而不是卡死 | `core/src/structure/StructurePlacement.ts` |

## E. 数据与目录

| # | 症状 | 根因 | 修法 | 怎么验证 | 代码位置 |
|---|---|---|---|---|---|
| E1 | 结构列表报 `missingFile`，文件明明在 | 公共结构必须放在 `data/nbt/public/<名称>/` 子目录 | 放错位置要在游戏内给明确提示，而不是只在控制台报错 | 手工放错 → 有提示；放对 → 能读到 | `core/src/structure/StructureStore.ts` |
| E2 | 结构名带空格时指令解析失败 | 命令按空格切参数 | 统一 `quoteArg` 加引号 | 存成 "黑黑 FF" 后 `/ca load "黑黑 FF"` 可用 | `core/src/view/StructureForm.ts` |
| E3 | `data/nbt` 下生成了大量无权限玩家的文件夹 | 遍历了全部玩家 | 只处理有权限的玩家 | 新号进服后不产生目录 | `core/src/structure/StructureService.ts` |
| E4 | 升级后配置注释全丢、旧配置读不到新增键 | 用 `JSON.stringify` 整体重写 | jsonc + `version` + 模板合并 | 升级后注释仍在、新键自动补齐 | `core/src/common/JsoncConfig.ts`、`Config.ts` |

## F. 文档与发布

| # | 症状 | 根因 | 修法 | 怎么验证 | 代码位置 |
|---|---|---|---|---|---|
| F1 | 发布包里目录互相嵌套、还带 node_modules | 构建没清 `dist/`、依赖打包策略错 | 精简包不含 node_modules（LSE 首启自装），全量包单独出 | 解压发布包看目录结构 | `scripts/build.mjs` |
| F2 | 文档写了"结构直接放 nbt 根目录"，用户照做失败 | 文档与实现不一致 | 文档以代码为准；CI 校验链接与配置键 | `npm run check:docs` | `docs/` |
| F3 | 版本号涨到 3.9.5，tag 却停在 v3.1.0，无法追溯 | 没有发布门禁 | `npm run check:version` + [发版规范](dev/release.md) | CI 报版本一致性 | `scripts/check-version.mjs` |

## G. 协作流程

| # | 症状 | 根因 | 修法 | 怎么验证 | 代码位置 |
|---|---|---|---|---|---|
| C12 | 旋转/镜像后粘贴出来的楼梯、原木、门"错乱"（形状转了、朝向没转） | `transformLayout()` 只重排索引，palette 的状态原样带走；预览侧也只转坐标 | 用 `StateRemap.remapStates()` 就地重映射方向性状态（stairs/cardinal/facing/torch/axis/sign），粘贴与预览共用同一张表 | 单测钉代数（4×90°=恒等、镜像两次=恒等）；live 逐格比对**服务端** states | `core/src/structure/StateRemap.ts`、`io/NbtCodec.ts` |
| C13 | 预览取消/超时后客户端还留半截，重登才干净 | `view*`族写的是**按玩家持久注册表**（区块重载/重登仍生效），只有 `viewClearBlock/viewClearAll` 能删；`blockFake*`族是普通方块包，靠重发包还原 | **一次预览只用一族**：全部走 `blockFake*`（含状态用 `blockFakeSetNbt`），teardown 才覆盖得到；绝不用 `viewBlockById` 做叠加 | 取消后 `viewDescribe` 计数归零、重登前后一致 | `core/src/holo/BlockView.ts`、`PreviewScene.ts` |
| C14 | 状态/方块实体"发送成功"但画面不变（楼梯仍基态、旗帜仍黑） | 超过 `previewBatchImmediate`（默认 256）的批量是**排队分帧**下发的；紧跟其后的即时逐格写会被后到的基态方块覆盖 | 带状态/带方块实体的格子**不进批量**，改由逐格路径一次写对（本体→实体数据），与批量写的是不同格子 | `/ca tools debug` 的"批量格数+逐格格数=结构格数"；画面朝向与图案 | `core/src/structure/PreviewScene.ts` |
| C15 | 粘贴后客户端没有任何变化，且"推送 0 格"毫无报错 | `mc.getPlayers()` **不存在**，LSE 的真名是 `mc.getOnlinePlayers()`；防御性 `typeof` 判断把错名静默成了空数组 | 用 `mc.getOnlinePlayers()`，并把 `在线/同维度/半径内/推送/失败` 分开计数 | `/ca tools debug` 出现"在线 N"且 live 断言该函数存在 | `core/src/holo/PasteSync.ts` |
| C16 | 预览 0° 正确、旋转后楼梯朝向又错 | 两个 `extractSurface(...)` 调用点**恒传 0°/none**，真实角度只在 `planCells → cellOffset` 里；把状态重映射放在提取期等于用错角度 | 重映射搬到 `planCells()`（唯一知道真实角度的地方），block 携带 palette 条目引用现算 descriptor | 单测：同一 raw 在 0/90/180/270 下 `weirdo_direction` 依次 0→2→1→3 | `core/src/structure/PreviewPlan.ts`、`SurfaceExtract.ts` |
| C17 | 粘贴后带方块实体的方块（旗帜/箱子/告示牌）直接消失 | 兜底里用了 `mc.setBlock(x,y,z,dimid,name,data)`——**LSE 没有这个重载**，抛出的异常被 catch 吞掉，格子保持空气 | 改用文档形态 `mc.setBlock(pos, name, tileData)` 或 `mc.setBlock(pos, nbt)`，失败时 logOnce | live `ca.bannerRoundTrip` 断言 paste 后 dst 仍是 banner | `core/src/structure/StructurePlacement.ts` |
| C18 | 预览与粘贴的旗帜都是纯黑，但复制/解析里确实有方块实体数据 | `snbtOf()` 依赖 `toLseTag(...).toSNBT()`；含**复合标签列表**（旗帜 `Patterns`）时转换返回**空串**，调用方把它当"没有载荷"丢掉 —— 箱子（`Items:[]` 空列表）却正常，于是长期被误判成"复制丢数据" | 自己写 SNBT 序列化（`snbtWrite`），不经过 LSE；粘贴侧用 `NBT.parseSNBT(snbtOf(tag))`，`toLseTag` 只作兜底 | live `ca.bannerCopyAudit`：旗帜载荷 `snbtOf` 长度必须 > 0；`ca.bannerRoundTrip`：粘贴后 BE 含 `Base`+`Patterns` | `core/src/io/NbtCodec.ts`、`structure/StructurePlacement.ts` |
| C19 | 预览构建途中取消，客户端留下半截假方块 | 取消只停了我们自己的 `BatchSender`；HologramLib 内部还排着没发完的批次，它们晚于还原包落地，把假方块又画回来 | 取消时先 `BatchSender.cancelOwner("preview:"+xuid)` 停喂；还原进延迟队列，等库队列排空（上限 3s）后再发，并**重发一次**兜住在途包 | `/ca tools debug` 的"取消清理"行；真机中途取消不再残留 | `core/src/structure/PreviewScene.ts`、`BatchSender.ts`、`CleanupGate.ts` |
| C20 | 移动/旋转过预览后取消，残留整段假方块（清理计数只覆盖最后一片） | 每次重建都 `discardCleanup + clear`：旧场景的清理任务被丢弃、账本被清空，新场景只知道自己画的格子，于是"旧足迹里已经不在计划内的格子"再没人清 | 重建改为**继承账本**：`detachScene()` 不发包、把 applied/stale/everApplied 交给新场景，diff 自然清掉离开计划的格子；只在维度/玩家变化时才真正还原 | `/ca tools debug` 的"取消清理 …·继承 N 格"；nudge/rotate 后取消无残留 | `core/src/structure/PreviewScene.ts`、`CleanupGate.ts` |
| C21 | 取消预览后残留，且清理计数远小于实际画出的格数 | 账本只记"发包成功"的格子；任何一条绘制路径（尤其后来改成逐格的方块实体格子）漏记，取消就永远清不到它 | **计划即记账**：`enqueue()` 把本次计划的所有格子写进 `everApplied`，取消按超集还原（重复还原是无害的空操作）；还原改为按**坐标集合**回写，不再按数量切片 | `/ca tools debug` 的"取消清理 累计 N 格"应接近结构格数；`取消:` 调试行显示 applied/ever 对比 | `core/src/structure/PreviewScene.ts`、`holo/FakeBlocks.ts` |
| C22 | 取消后残留，且 `ever` 明显小于本场景实际发过的格数 | 还原包"已提交"就当成"客户端已看到"，`markCleared` 顺手把格子从 `everApplied` 删掉；库一旦丢掉那个清除包，格子就成了**无人记得的幽灵** | `markCleared` 只删 `applied`，`everApplied` 保留（取消时按超集还原，重发真实方块是空操作）；超长会话给 `everApplied` 设 20 万格上限 | `debugMod` 的 `取消:` 行里 `ever` 应接近本场景累计发送格数 | `core/src/structure/GhostLedger.ts`、`PreviewScene.ts` |
| C23 | 取消后残留，日志显示 `请求=1506` 但 selfTest `changes=1272`、`bad=1` | `packCells()` 会跳过"打包格式装不下"的条目（描述符里有 `;`、坐标非整数），而 `restoreDetailed()` 忽略 `packed.skipped` 并照样报"已还原 1506"——那 234 格从未发出任何包 | `isPackableId()` 统一判定；不可打包但有描述符的格子进 `direct`，由单格通道 `BlockView.set` 补发；`restored` 只统计真正进了段的条目 | `还原:` 日志里 `单格补发 N 格`、`selfTest bad=0`、`changes` 等于可打包数 | `core/src/holo/FakeBlocks.ts`、`structure/PreviewScene.ts` |
| C24 | 预览大建筑有空洞；取消后残留量随格数线性增大，小结构却完全正常 | **打包字符串在 ~16 KB 被截断**（LSE 传参上限），而 `PACK_MAX_BYTES` 设成了 512 KB → 超出的条目从未进库，且库不报错 | 段预算降到 **12 KB**（留 25% 余量），大载荷自动分段；`blockBatchSelfTest` 的 `changes` 必须等于该段条目数 | 复测：`还原:` 里 `changes` ≈ `可读`；`/ca tools debug` 的 `库坏项` 不增长 | `core/src/holo/FakeBlocks.ts` |
| C25 | 预览微调/旋转后立刻粘贴：服务端粘贴成功，客户端却残缺，重进才恢复 | 还原包携带的是"读世界那一刻"的方块（粘贴前），粘贴与清理并发时它们落在刚写好的格子上 | 粘贴前 `PreviewOperation.cancelFor` + `PreviewScene.flushCleanup()`（等清理任务与库队列都空，上限 4s），再执行粘贴；`/ca paste` 与魔杖两条路径都要等 | 日志出现 `粘贴前等待清理完成 Nms`；快速预览→粘贴不再残缺 | `core/src/structure/PreviewScene.ts`、`PreviewOperation.ts`、`CACommand.ts` |
| C26 | 主世界正常，**地狱/末地**取消预览后残留；日志 `还原: 可读=0 不可读=N` | 代码从 `caPlayer.$.dimid` 取维度，而 **`Player` 没有 `dimid`**（只有 `IntPos`/`FloatPos` 有）→ `?? 0` 恒等于主世界；还原时用主世界维度读地狱坐标 → 区块未加载 → `mc.getBlock` 全 null → 一格都没还原 | 统一用 `dimensionOf()`（`pos.dimid` → 选区 `dimid` → 0，`-1` 视为无效）；`可读=0` 时打 error 并带维度与样例坐标 | `还原:` 行应变为 `可读=N 不可读=0`；地狱/末地取消无残留 | `core/src/common/Dimension.ts`、`structure/PreviewScene.ts` |
| C27 | 换维度后选点报"两点不在同一维度内"，连"取消选区"也报错 | 选区两个角各存在不同维度，`hasSetArea()` 直接 `throw`；而选点与取消（`clearArea → hideArea`）都走这条路 | 守卫改为**容错**：`selectionState()` 判定 `mixed` 即视为过期选区、就地 `dropSelection()` 并返回 false；另加 `onChangeDim` 监听自动清选区、复位 A/B 状态、隐藏线框并取消旧维度预览 | 换维度后选点/取消都不再报错；`/ca tools debug` 无异常栈 | `core/src/common/Selection.ts`、`structure/AreaOperation.ts`、`app.ts` |
| C29 | 旋转/镜像后箱子朝向不变（预览里也固定一个方向）；活板门朝向没跟着转 | ①`blockSnbtOf()` 的键白名单是 `/^[A-Za-z0-9_.\-]+$/`，**不允许 `:`**，而箱子的状态键是 `minecraft:cardinal_direction` → 键被丢弃、SNBT 变空 → 该格退回批量通道（基态朝向）；②`remapStates()` 按裸键匹配，命名空间键不参与重映射；③活板门/门用 `direction`，不在映射表里 | 键白名单加入 `:`；重映射先剥命名空间再查表，并支持 `cardinal_direction` 的**字符串值**（"north"/"south"）；`direction` 复用四向表（门/活板门/栅栏门） | 真机：`ca.stateKeysProbe` 断言键带命名空间；单测覆盖命名空间键、字符串值、`direction`；预览里箱子随旋转改变朝向 | `core/src/structure/SurfaceExtract.ts`、`StateRemap.ts` |
| C30 | 复制带画（或展示框）的结构，粘贴后画消失；无论怎么改 NBT 都没用 | 画/展示框是**实体**，而 `mc.getStructure` 在这版**不采集实体**——实测保存含盔甲架的选区，字节里连 `armor_stand` 都没有；`structure.entities` 恒为空。另一侧 `/summon minecraft:painting` 与 `mc.spawnMob("minecraft:painting")` 也都失败（`armor_stand` 两者都成功） | 带实体只能用引擎命令：复制时 `/structure save <id> <from> <to> true`，粘贴时 `/structure load <id> <pos> [rot] [mirror] true`（实测方块+实体一起往返）；自有 `.mcstructure` 仍只存方块，回退时提示"实体未还原" | `ca.structureCommands`：save→删除实体→load→实体回来 | `core/src/structure/NBTService.ts`、`docs/dev/architecture.md` |
| C31 | 活板门 0° 正常、一旋转朝向就错；悬挂木牌旋转后文字跑到背面 | ①`direction`（门/活板门）用的是**楼梯族**索引顺序，不是 `cardinal_direction` 的；②悬挂牌的文字朝向来自 **`ground_sign_direction`**，而我们的重映射把 90° 算成了 **-4**（引擎实测是 **+4**） | `direction` 改用 STAIRS 表；`ground_sign_direction` 改为 `(d + 4*steps) % 16` | 单测：`direction` 0→2 @90°、`ground_sign_direction` 0→4 @90°（均已按引擎实测固化） | `core/src/structure/StateRemap.ts` |
| C32 | 画/展示框复制粘贴后消失；用协议实体预览时**客户端崩溃** | 画是实体：脚本层读不出 `structure.entities` 的条目，`/summon` 与 `spawnMob` 拒绝生成画；库的协议实体缺图案/尺寸数据会让客户端崩（服务端无感） | **决定不支持**：不采集、不预览、不粘贴，文档写明（`docs/user/known-limitations.md`）；只保留"引擎能带实体"这条事实备查 | `ca.engineFacts` 记录实测（actor 标识在字节里、NBT API 读不出条目、协议实体会崩客户端） | `docs/user/known-limitations.md`、`AGENTS.md` |
| C33 | 撤销/粘贴覆盖**带物品的箱子**后，物品全掉在地上 | 引擎在容器方块被替换时按"容器损坏"处理并掉落内容。**用 NBT 写空容器无效**：实测 `removeTag("Items")+setNbt` 报告成功、容器真空了，物品照样掉——"这次写入"本身就是诱因 | 改用**容器 API 逐格清空**（`Block.hasContainer()` + `getContainer().removeItem()`）：不销毁任何东西，随后替换方块时容器已空 → 不掉落。开关 `silentContainerClear`（默认开） | `ca.containerNoSpill`：`chest with 2 stacks replaced, spilled=0, containers cleared=1` | `core/src/structure/ContainerClear.ts`、`StructurePlacement.placeLayoutAsync` |
| C34 | 走进预览内部卡顿（假方块挡住/实体太多），希望"靠近可穿" | 假方块是客户端方块，玩家进不去；全换成实体则实体数量爆炸 | 用库的 `blockBatchSetNear`：靠近 radius 的格子发 air + 生成隐身 `minecraft:sulfur_cube`，离开 radius×1.3 恢复。**关键约束**：每次调用整体替换该玩家集合（`setManyNear` 先销毁旧立方体）→ 只能整窗发送 + 节流（移动>radius/2 或场景变化）；受 ~16KB 参数预算 → `previewNearCells` 截断；库每 4 tick 扫描注册格 → 只注册附近窗口；**方块实体格必须排除**（离开只重发方块本体） | `ca.nearBlocks`：`nearPass=true`、两次注册各自新 batchId、`clear` 后 `nearSets=0`；客户端：走进预览不卡且能穿过、走开恢复、取消无残留 | `core/src/holo/NearBlocks.ts`、`structure/NearWindow.ts`、`structure/PreviewScene.ts` |
| C35 | 靠近可穿只在**落点附近**生效，走到别处没反应；楼梯预览朝向被打乱 | ①`startTimer` 对 `mode="full"` 直接 `return`，而 near 窗口唯一的重算点在 pump 结束时 → 队列清空后再也不更新，窗口永远停在第一次计算的位置；②之前把 `nearWindow` 也算进节流 key 且带 4 秒兜底 → 每轮都重注册（销毁/重建立方体）；③状态方块（楼梯）同时被"逐格 SNBT"和"near 批量"两条路径重发，批量描述符与逐格不一致时朝向错乱 | ①ticker 对所有模式启动，full 模式只跑 `syncNear` 不跑 `refreshWindow`；②节流 key 改用 `contentVersion`（`enqueue` 时递增），去掉 4 秒兜底；③`selectNearCells` 默认**排除带状态的描述符**（`id` 含 `[`），状态方块保持实心，需要时用 `allowStates` 打开 | 单测：状态方块默认不被选中、`allowStates` 可开；live `ca.nearBlocks` 通过；客户端：走到预览任何位置都生效且楼梯朝向不变 | `core/src/structure/PreviewScene.ts`、`structure/NearWindow.ts` |
| C36 | 用库的 `blockBatchSetNear` 做"靠近可穿"时，楼梯朝向被打乱、箱子/告示牌内容丢失；状态方块只能保持实心 | 该接口会把整窗通过**批量状态串**重发，而状态串解析器**不认状态**（实测 `blockFakeResolve("minecraft:oak_stairs[weirdo_direction=2]")` 返回与 direction=0 **相同**的网络 id；`blockFakeResolveNbt` 才正确）→ 重发即打乱；且离开时只重发方块本体，方块实体数据丢失 | 改为**自管理**：进入时 `blockFakeClear` 该格 + `sulfurCreate`（`invisible=true`，主手放该方块物品）+ 记录；离开（1.3× 滞回）时 `sulfurDestroy` + 用**绘制时的原载荷**（SNBT / block entity）逐格重发。带状态与带方块实体的格子都能穿且能正确还原 | `ca.nearBlocks`：`nearPass=true cube=1 creates=1 destroys=1 failures=0`；客户端：楼梯可穿且走开后朝向不变、箱子内容不丢 | `core/src/holo/NearBlocks.ts`、`structure/PreviewScene.ts`（`syncNear`/`redrawCell`） |
| G1 | 同一个"偏一格"改了七八轮还在偏 | 猜测—重启—试探，没有先验证输入层 | 先查文档/源码，再逐段验证命令链 | 一次定位到 `normalisePositions` | 见 `AGENTS.md` 第 0、1 节 |
| G2 | `ll reload` 之后本插件指令失效 | 重载其他插件会打断命令注册 | 重启服务器，而不是热重载 | 重启后 `/ca` 恢复 | 本台账 |
| G3 | 启动告警"内置工具物品尚未生效，请重启服务器"被当成故障 | 包启用需要世界重载 | 按提示重启一次即可 | 重启后 `/ca tools` 显示生效 | `core/src/addon/AddonInstaller.ts` |

## 新增条目的写法

1. **一行一个症状**，写用户看到的那句话，不写内部术语；
2. 根因要能指向**具体 API 语义或版本差异**，不写"逻辑有问题"；
3. 修法写"改成什么"，并注明是否会影响其他功能；
4. 验证一列必须可执行：探针指令 / `debugMod` 日志关键字 / 单测用例名 / 真机步骤；
5. 代码位置写文件路径（可多行），方便下次直接跳转。

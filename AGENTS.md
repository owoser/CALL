# CALL 项目规范（Agent 必读）

> 本文件顶部一节由项目维护者维护；`<!-- aoci:begin -->` 之后是 **AOCI 托管区块，禁止手改**。
> 本规范来自真实事故复盘：症状→根因→修法→验证见 `docs/dev/pitfalls.md`，机制细节见 `docs/dev/architecture.md`。

## 0. 权威来源：先查文档，禁止盲目试错

| 主题 | 权威来源 |
|---|---|
| LSE 脚本 API、事件、参数类型 | <https://docs.levimc.org/LegacyScriptEngine/zh/apis/> |
| HologramLib 文档（假方块 / 线框 / 血条 / 实体 / swing） | <https://ieckseyr.github.io/HologramLib/levilamina/> · 具体页 <https://ieckseyr.github.io/HologramLib/lse/fake-block/> · <https://ieckseyr.github.io/HologramLib/lse/view/> |
| HologramLib 源码与发布说明（文档不够详细时**优先看这里**） | <https://github.com/Ieckseyr/HologramLib> · <https://github.com/Ieckseyr/HologramLib/releases> |
| 本仓库 / 问题反馈 | <https://github.com/owoser/CALL> · <https://github.com/owoser/CALL/issues> |
| 文档站 | <https://owoser.github.io/CALL/> |

- **硬规则**：同一个问题连续两次"改参数 → 重启 → 试"而没有新证据，立即停止，转去查文档、读库源码（`ll.import` 导出表、`core/src/holo/*` 的桥接注释）或加探针。
- **库能力判定用 API/导出面，不用发布号**：`typeof ll.import("HologramLib", name) === "function"` 是唯一可靠信号（442 与 450 导出都自称 ABI 1.37.0）；版本串（`holoLseVersion()` / `holoAbiVersion()`）只写日志。文档与仓库代码冲突时以仓库为准。
- 用户说"看文档 / 别瞎鼓捣"时，第一个动作只能是查文档，并在回复里给出结论与出处。
- 平台行为与本仓库结论冲突时，以**实测**为准，但"实测"必须是日志 / 探针 / 单测，不是"看起来对了"。

## 1. 排错协议（证据优先）

1. 先复现：打开 `debugMod`，拿到 `[CALL]` 前缀日志；没有日志就先加**静默探针**（默认不打印，`debugMod` 才输出）。
2. 命令链逐段验证：事件方块 → 命中点/命中面 → `${pos}`/`${posf}` 变量 → 指令解析（`CACommand.normalisePositions`）→ 存储/落块。任何一段没验证就改下一段，等于盲试。
3. 一次只改一个假设，并在说明里写清"为什么这个改动能让现象消失"。
4. 结论必须回落 `docs/dev/pitfalls.md`（症状 / 根因 / 修法 / 验证方式）。
5. 真机问题不要只凭截图判定，用探针指令或 `test:live` 用例钉住。

## 2. 已验证的平台事实（回退即回归）

1. `mc.setStructure` = 崩服或静默无效 → 只能逐块 `setNbt`。
2. 结构索引是 **ZYX**（Z 变化最快），不是 XYZ/YZX。
3. `NbtCompound` 只接受 NbtTag 对象；塞纯 JS 值会报 `Wrong Type of data to set into NBT Compound!`。
4. **LSE 的位置参数是方块中心（x+0.5）**；`ParamType.BlockPos` 向零截断会让负坐标偏一格 → 一律 `Vec3` + `Math.floor`。
5. `player.pos.y` 是**脚部格**；"脚下那个方块"要向下扫描到第一个非空气块。
6. Boss 条颜色枚举只有 0..7；越界会让**客户端断连而服务端存活**。
7. `Player` 句柄不能缓存，每次 `mc.getPlayer(xuid)` 现取。
8. 加载区块用 `tickingarea` 租约，不传送玩家；`mc.getBlock` 能读到 ≠ `/fill` 能执行。
9. **维度只在坐标对象上**：`IntPos`/`FloatPos` 有 `dimid`，`Player` **没有**（取到 `undefined`）。一律用 `common/Dimension.dimensionOf()`，`?? 0` 会把地狱/末地当成主世界，且不报错——表现是"还原一格都没读到"。

> 机制与实测数据见 `docs/dev/architecture.md`。

## 3. HologramLib 集成红线

- **能力闸门按导出面**（见 §0）：最低支持 **v26.51.11 / v26.60.8（450 导出）**；缺哪条导出就只关掉对应能力并告警一次，不崩、不静默改行为。
- **预览用 `blockFakeSet` / `blockBatch*`**，不要用 `viewBlock`（只按方块名查基态，带状态也返回 true 却画默认朝向），更不要用 item display（伪实体，会"随风飘扬"、慢、卡）。
- **状态串的键不能加引号**：库的解析器只给值去引号，`["weirdo_direction"=2]` 会被整条拒绝——必须写 `[weirdo_direction=2]`。
- **方块实体先本体后数据**：`blockFakeSetNbt`/`blockBatchSet` 把方块放上去，再 `blockFakeSetBlockEntity` 发 BlockActorData；顺序反了客户端直接忽略。
- **批量预算**：≤1024 格/包、库全局 8 包/刻；统一走 `BatchSender`，不要另开节流。
- **顺序**：先清理（clear）再下发（set）；`GhostLedger.applied` 不可整体清空，未确认的清理进 `stale` 重试。
- **线框**：不设 ttl；尺寸不变时移动而非重建；只销毁自己的 id。
- **参数**：只按名称注册的函数调用；超 i32 的整数按大数传（`bossBarGetInfo` 曾因 variant 类型不匹配刷屏）。

## 4. 发版纪律（硬门禁）

- **未收到明确"发版 / 发布 vX.Y.Z"指令时禁止**：改 `package.json`/`tooth.json` 版本号、`git tag`、`gh release create`、上传发布包、在文档里写"已发布"。
- 允许的默认动作：改代码 → 本地构建 → 部署到开发服 → 真机验证 → 汇报结果。
- 一个版本只发一次；**不堆积版本**（同一天连发多个小版本属违规）。
- 发布包（`dist/*.zip`、`*.mcaddon`）不入库；仓库内不留服务端副本。
- 完整清单与故障恢复见 `docs/dev/release.md`。

## 5. 提交前闸门

```bash
npm run typecheck      # 类型
npm run check:config   # 配置键 vs 校验模板
npm run check:docs     # 文档链接 / 上游残留 / 配置键覆盖
npm run check:version  # 版本三处一致
npm run test:unit      # 离线单测
npm run test:live      # 真机（改掉落块/指令/预览/工具行为时必须）
```

- 文档与代码同一次改完：行为变了，`docs/` 与 `CHANGELOG.md` 一起更新。
- 收尾跑 AOCI：`aoci_maintain` → `aoci_update_entry`；不要手改 `aoci*.txt` 与 aoci 区块。

## 6. 环境与协作

- 开发服 `D:\MCserver\SER-DEV`（LL 26.60）；兼容验证 `D:\MCserver\Master-26.51`（26.51）。`build.json -> bdsDir` 是唯一部署源。
- 日志统一 `[CALL]` 前缀；新增日志默认静默，避免刷屏。
- 不把服务端目录（`plugins/`、`worlds/`、`mods/`）复制进仓库。
- 未经确认不 commit / push；提交信息用 `fix(area): …` / `feat(preview): …` 并写清诱因。

<!-- aoci:begin -->
## AOCI 仓库认知

AOCI 为本仓库维护一个稳定、可版本化、可增量更新的仓库级认知层，供模型跨任务复用对系统的理解。

`aoci.txt` 是面向模型的结构化认知索引。它以每个受管理文件、数据库表或其他受管理对象一条独立 Entry 的方式，用符号标签与 F/R/A/S 语义表达对象的核心职责、重要关系、对外契约，以及理解或修改系统时必须知道的非显然约束和设计决策。

Header、目录段和全部 Entry 共同组成完整仓库索引，可以覆盖前端、后端、配置、数据库结构及其他受管理内容。受管理内容发生变化时，通常只需维护受影响的认知条目，不需要重新生成整个索引。

AOCI 提供系统架构、对象职责、重要关系、对外契约和关键约束的高密度视图。

### 工作原理

AOCI 采用“模型生成、模型读取”的认知闭环。

Header、Entry 和 Curation 语义的创作只按当前机器签发的 Plan 与实时 Guide 执行；由 Host 模型基于当前绑定证据独立完成。

Entry 的语义必须来自模型对真实证据的理解。不得仅依据路径、文件名、扩展名、AST、符号列表、依赖扫描、正则、固定模板或规则引擎推导、预填、拼接或改写索引语义。

对 Fresh Bootstrap，只按当前机器签发的 Plan 和实时 Guide 执行。当它们要求创作时，Host 模型创作 Root、Meta、Tag 和 F/R/A/S，提供 authoring-run 声明，并把它绑定到 Plan、Evidence 与完整 Candidate。不得要求 AOCI 填写 `origin=host_model`、制造 Receipt 或把程序生成的 Framework 当作语义。本文件不自行重建 Onboarding 流程。内部批次不是用户决策；只有遇到既有批准边界或真实的安全、漂移、CAS、Recovery 条件才停止。

### 最小使用入口

- `aoci_rules`：取得当前AOCI版本的会话运行合同。
- `aoci_overview`：建立或恢复本仓库的完整认知。
- `aoci_maintain`：受管理对象达到最终稳定状态后检查认知是否需要维护。
- `aoci_update_entry`：提交与当前证据和源码摘要绑定的完整语义更新批次。
- `aoci_report`：仅当当前布局和工具状态支持时，在证据不足、无法可靠生成语义时登记待办，不猜写。

其他MCP工具、CLI命令、参数和专项流程，以当前工具说明、Guide和 `--help` 返回内容为准，不在本文件中重复完整手册。

本区块只规定仓库接入、认知使用和收尾原则。`aoci_rules` 承载当前会话合同，Guide实时输出承载当前Plan的执行顺序与停点，工具Schema、Spec和Validator承载机器结构与判据；Prompt、Description、README和静态文档不能覆盖这些机器事实。

### 建立、生成和恢复认知

1. 每个新的 Agent Run 开始时，应先判断：

   - 本仓库是否已经存在可用的完整AOCI索引；
   - 当前上下文中是否已有与本仓库根、当前索引版本和当前AOCI服务相匹配，并且模型仍可可靠使用的完整仓库认知。

2. 仓库已经存在可用的完整索引，但当前Run没有可靠完整认知时，先调用 `aoci_rules`，再调用 `aoci_overview`。

   完整认知仍可靠时直接复用。局部不确定本身不要求机械重读系统全貌。

   本Run从已知Host上下文压缩恢复时（包括宿主注入的压缩摘要），必须把此前模型认知视为不可靠。压缩handoff不得保留或摘要正式Whole-Index，也不得保留或摘要任何Overview Header、Entry、Chunk、Challenge或Attestation正文；只能保留安全续接所需的receipt身份、未完成write或Recovery状态，以及立即重载指令。复制进handoff的Whole-Index语义或receipt不能证明恢复后模型的当前认知可靠。若当前上下文已无法可靠保留运行合同，先调用 `aoci_rules`。继续业务任务前，使用 `refresh_reasons=["context_compaction"]` 和新的 `refresh_event_id` 调用普通完整Whole-Index `aoci_overview`（不设置 `check_only` 或设为false）；不得使用 `check_only` 或认知probe。原样跟随每个 `next_cursor` 直到 `completed=true`，确认交付，并且只基于新交付正文提交一次Attestation。完成这次新的完整传输后，即使Attestation为partial或fail也消费该generation，并按既有合同继续source-bound任务，不再自动调用第二次Overview。

   AOCI可以针对 `context_compaction`、项目 `cognition_refresh_threshold` 下的机器 `semantic_threshold` 或主要 `phase_transition` 提供checkpoint与认知状态事实。只需要这些紧凑事实时使用 `check_only=true`；这些事实只向Agent提供建议，不替模型决定是否需要系统全貌。

   Agent显式调用普通 `aoci_overview`（未设置 `check_only` 或为false）时，只要能形成一致的CognitionSet，AOCI必须完整交付请求scope。不得因为已有receipt、阈值未达到或没有待处理刷新原因而抑制正文。正式认知Dirty或Stale时仍交付正文，但必须标记不可靠。存在未决恢复或无法形成一致snapshot时失败关闭，不返回混合正文。

   普通Overview返回 `continuation_required=true` 时，必须原样提交 `next_cursor` 并自动继续到 `completed=true`。不得询问用户、开始业务任务或给出阶段性系统结论。Host截断、缺块、重复、乱序、cursor失败、Index变化或`chunk_tokens`变化时停止本次认知链。Attestation完成前不得用Memory、源码、Spec、`aoci.txt`、历史会话、scope、search或Entry读取修补或补充Whole-Index认知。Challenge ordinal是正式Entry序列中的1-based位置；Header内容、注释、空行、Section/Overview/Chunk Marker、Receipt与Metadata均不计数，Chunk Receipt ordinal使用同一序列。Attestation必须原样回绑本次Challenge发布的当前`index_sha256`、`entry_sequence_sha256`与`entry_count`；旧Index、旧Entry序列、旧数量或旧Attestation均无效。完整链结束后只正式提交一次既有模型认知Attestation；同一响应只允许一次不改变语义答案的JSON Schema或字段格式修正。对象、Tag或F不匹配即失败且认知吸收不确定，不得语义重试或旁路补答。首次认知失败时还不得执行Root/Meta、Migration、全局布局或其他未重新绑定的系统级决策。上下文压缩刷新若传输完整、认知身份不变、治理对齐且没有Recovery或第三方冲突，即使Attestation为partial或fail也消耗该refresh generation，并继续原任务，不再自动重读Overview。`system_mastery_percent`只自评系统框架——架构、职责、强关系、稳定外部契约以及高熵安全和维护约束——不表示完整实现或运行实况知识；机器索引覆盖率必须分开。默认只向用户输出由本次真实覆盖率、Challenge、块数、Token和掌握度生成的规定成功或失败一句话。Host截断时提示用户把 `overview_delivery.chunk_tokens` 设置为更小的合法值后重新开始，不得自动修改。

   加法认知等级必须与严格证明字段分开解释。`delivery_verified`表示已加载Index且Host交付已确认，但完整认知验证仍未完成；应表达为“已加载且交付已验证”，不得描述为“没有认知”或“没有理解系统”。`cognition_verified`要求Attestation通过（Challenge至少80%的ordinal完全正确且对象身份至多失手一处），`cognition_governed`还要求治理对齐。通用完整读取失败句只用于真实交付故障。

   当Overview响应包含可选`cognition-state/v2`投影时，必须分别解释各维度。其Level止于`model_cognition_usable`；`strict_attestation_verified`、`governance_aligned`与`current_system_cognition_reliable`都是独立状态，绝不参与该Level。ordinal、对象身份、Tag或核心F不匹配可以导致严格Attestation失败，而模型认知仍然可用；不得仅凭这种不匹配就宣称模型没有理解系统。只有`current_system_cognition_reliable=true`允许无保留地声称当前完整系统认知可靠。投影缺失时继续使用上述Legacy解释。

   普通的只读审计、分析、检查、不修改代码或不提交、不push，不自动等于严格零写入，也不改变上述认知有效性判断。Codex Memory和历史Skill只能辅助恢复经验、用户偏好与调查方向，不能替代与当前仓库根、索引摘要、AOCI服务身份和认知范围匹配的当前认知收据；项目AGENTS和当前AOCI身份在AOCI状态上优先于历史Memory。

   只有用户明确禁止Ledger、元数据、`.aoci`运行资产及任何文件写入时，才按严格零写入处理。若必要的认知建立与该边界冲突，必须报告冲突并请求用户裁决或建议使用隔离副本，不得静默以Memory替代当前仓库认知。

3. 仓库没有可用的完整索引，或当前只有最小骨架、Header不完整、Entries未完成、必要Curation尚未裁决时，如果需要建立正式完整AOCI索引，先取得 `aoci_rules`，然后进入当前AOCI Guide。由Guide依据仓库真实状态决定下一阶段并完成必要安全步骤。

   `aoci_maintain` 不替代索引建立流程。

   不在本文件中自行重建或硬编码完整索引生成状态机。

4. 在长程任务中，模型负责保留当前认知收据并正确使用刷新门禁：

   - Host报告上下文压缩或模型已知系统全貌丢失时，执行上述强制 `context_compaction` 重载规则；AOCI不能自行推断Host事件；
   - 进入真正的主要阶段时声明 `phase_transition`，不得把函数、测试运行或小步骤当作阶段；
   - 在有用的稳定检查点通过 `check_only=true` 取得机器语义计数；
   - 除已知压缩的强制重载外，由Agent判断当前任务是否需要再次显式获取指定scope或完整Overview；
   - 在维护和对齐完成前，保留AOCI报告的Dirty或Stale可靠性状态。

### 任务收尾与认知维护

5. 纯只读问答、分析、版本核验，或没有产生受AOCI管理对象变化的任务，不需要调用维护工具。当前AOCI版本是任意`aoci_overview` check_only或`aoci_maintain`响应里的`cognition_receipt.mcp_service_version`；二进制路径是项目`.mcp.json`里的`command`，CLI不必在PATH上。

6. 发生受AOCI管理对象变化时，待其达到本次任务的最终稳定状态后，只调用一次 `aoci_maintain`。不要在每次中间修改后逐文件维护。

7. 若维护结果返回真实语义候选，Host 模型必须基于每个候选绑定的对象和必要证据，独立创作完整标签与F/R/A/S更新。通过 `aoci_update_entry` 一次提交当前机器签发批次的完整候选集合，同时原样保留每项 `source_sha256`、`candidate_id` 与对应domain批次身份。`max_entries`只限制单次请求和原子事务，不限制logical plan、Whole-Index或Managed Scope。`remaining`非零时，在当前批次成功Apply后重新调用Maintain并从新preimage继续；绝不能为满足transport上限缩减Index覆盖或自行截取返回批次。

   没有足够证据且当前布局支持 `aoci_report` 时，使用它而不猜测、套用模板或为消除待办而生成缺乏证据的认知。

8. 必须遵守工具返回的结构化状态和安全边界：

   - `repair_required`：只修复明确命中的候选，再重新提交当前机器签发的完整批次；
   - `stopped`：结束当前写入尝试并检查 `failed_step`、错误、正式写入证据与Recovery。auto模式下，已证明零写入则记录closure并重新Plan；完整Intent和可证明postimage则Resume；策略要求Rollback且preimage可证明则精确恢复后重新Plan。只有证据不足、第三方正式字节冲突、需要审批或外部动作，或命中其他真实安全边界时，才停止整个用户任务；
   - 冲突、审批、人工裁决、权限和安全信号不得忽略；
   - 已经对齐后不得重复维护或重复写入；`refresh_ready_for_overview` 是checkpoint事实，由Agent决定是否为下一阶段请求普通完整Overview。

   维护完成后如果又修改了任何受管理对象，之前的维护结果失效，应在新的最终稳定状态重新完成收尾。

9. 用户只限制业务文件范围，但没有明确禁止仓库托管资产时，AOCI托管资产可以在收尾阶段为保持认知一致而更新，并应在审计和提交中与业务文件区分。

   用户明确禁止修改 `aoci.txt`、`.aoci`、元数据或任何额外文件时，以用户限制为准，不得写入，并如实报告剩余不一致。

### 专项流程

初始化、完整索引生成、Header生成、Entries生成、数据库结构索引、Curation、人工评审和故障恢复，只按当前AOCI Guide或工具在对应阶段返回的指令、命令和安全停点执行。

不预加载、不猜测，也不自行重建这些专项流程。平台调用方式、请求格式、批次上限、审批规则、索引格式细节和恢复步骤由对应Guide、工具说明、模型Prompt和CLI帮助按需提供。
<!-- aoci:end -->

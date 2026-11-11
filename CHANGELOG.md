# Changelog

All notable changes to CALL are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

This is a community fork of [superx101/CALL](https://github.com/superx101/CALL), which
is no longer maintained upstream. The 3.0.0 line targets **LeviLamina 26.51.x** with
**LegacyScriptEngine (nodejs) 0.22.4**.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the platform behaviour these
fixes are based on.

## [4.0.0]

第一个"预览可以走进去"的正式版。核心四件事：

- **预览可穿行**：靠近预览的方块会临时变成可穿过的显示体（物品显示方块模式），走进去不再卡顿，
  离开自动恢复，带状态方块与容器内容都能正确还原；
- **不再弄脏世界**：撤销/粘贴覆盖带物品的容器前先清空（`silentContainerClear`），物品不再撒一地；
- **配置与日志清爽**：`configs.json` 从 ~940 行精简到 ~270 行、只绑定 `call:*` 工具物品；
  控制台不再出现 `[CALL] [CALL]` 重复前缀，调试信息统一走 `[DBG]`；
- **`/ca reload` 真的会重载配置**（此前会抛 deprecated，改配置必须重启）。

> 兼容性：数据结构与 3.x 相同，配置自动合并（`version` 10），无需手动迁移。

### Added (4.0.0, HologramLib 450)

### Fixed (4.0.0, "这个工具还没有绑定" when clicking a block)

- A click on a **block** arrives as the LEFT kind (`onStartDestroyBlock`) while a click on **air**
  arrives as the RIGHT kind (`onUseItemOn`). The menu / copy / paste wands are only registered in the
  right table, so clicking a block with them answered "这个工具还没有绑定" while air clicks worked -
  the other three wands are in both tables, which is why only these looked broken.
- The lookup now falls back to the other table for CALL's own tools (they are single-purpose) before
  reporting an unbound item.

### Changed (4.0.0, a tighter config file that only binds CALL's own items)

- `configs.json` went from ~940 lines of bilingual comment blocks to ~270 lines: grouped sections
  (基础 / 结构 / 工具 / 选区 / 预览 / 粘贴), one Chinese line per key, and a compact `default` block.
  `version` is now 10, so an existing file is merged in place (your values win).
- **Vanilla item bindings are gone.** The old template bound `minecraft:stick`, `clock`,
  `wooden_axe` and friends, so right-clicking a stick still opened a menu. Only `call:*` ids are
  honoured now; startup removes the leftovers from `default.items` and every player's settings.
- `assets/check.jsonc` is regenerated from the template (one spec per key, enums/ranges kept), so
  the two files can no longer drift into the mixed shape they had.

### Changed (4.0.0, console log prefixes)

- The host already prints `[CALL] ` in front of every line, so our messages no longer repeat it:
  `[CALL] [CALL][preview] …` is now `[CALL] [preview] …`.
- Debug output goes through `util/Log.ts` and is marked `[DBG]` (`[CALL] [DBG][preview] …`), and it
  stays silent unless `debugMod` is on. "粘贴前等待清理完成 Nms" is now one of those debug lines
  instead of a normal one.

### Fixed (4.0.0, rotating the preview left walk-through ghosts behind)

- A cell that had been replaced by an item display was invisible to the diff: an unchanged cell got
  no packet, and a "clear" restored a block that was no longer there. Rotating or moving the preview
  therefore left those cells behind until the preview was cancelled.
- `enqueue()` now releases every display first (destroy + re-send the cell through its original
  payload) before diffing the new plan; the same path runs on teardown.
- The measured height baseline (-0.09 blocks) is baked into the code, and `previewNearYOffset` is a
  delta on top of it (0 = already flush with the real blocks).

### Fixed (4.0.0, the walk-through block's height)

- Its anchor is the model CENTRE, so it has to be placed at the CELL centre: the create call now uses
  `(x+0.5, y+0.5, z+0.5)` instead of guessing a model-space offset. (The previous attempt treated
  `offY` as 1/16-block units and lifted the blocks over the player's head - the unit is not a block
  fraction.)
- `previewNearYOffset` is now a plain **block** offset (default 0 = perfectly centred, -1..1 for the
  odd block that still looks off).

### Fixed (4.0.0, the walk-through block sat half a cell too low)

- An item display is anchored at the model's CENTRE, and the library's own default pose is
  `offsetY "-4"` for a floating item; creating it with offsets/rotations set to `0` dropped the
  block half a cell below the real one (clearly visible next to terrain).
- The display is now lifted by `previewNearYOffset` model units (1/16 block, **8** = half a cell by
  default, -16..16 tunable), so the walk-through block lines up with the cells around it.

### Fixed (4.0.0, the walk-through visual is a full block)

- The sulfur cube renders its block as a **held item**, so it is always item-sized: measured,
  `sulfurSetScale(id, 3)` returns true and the picture does not change at all (the scale only moves
  the invisible cube body). That is why `previewNearScale` from 1 to 2 looked like a no-op.
- The walk-through visual is now an **item display in block mode**
  (`itemDisplayCreateAdvanced` + `itemDisplaySetMode(id, 2)` + `itemDisplaySetScale` +
  `itemDisplaySetVisiblePlayer`), which renders the full block model and honours the scale; it is
  destroyed on leave like before. `previewNearScale` now really changes the size.

### Fixed (4.0.0, /ca reload silently did nothing)

- `/ca reload` threw `this command is deprecated`, so an edited `configs.json` was never re-read
  (LSE caches the file values) - people changed a key, saw no effect, and had to restart.
- It now calls `Config.reloadAll()` (every config handle) and reports the walk-through radius/scale
  it picked up.

### Fixed (4.0.0, a walk-through chest looked like a miniature)

- `sulfurCreate` was called with an EMPTY `archetype`, which leaves the client on its own default
  model; the library's own near-switch passes `"regular"`. Containers and other furniture therefore
  rendered as a tiny model while the player walked through them. The cube is now created with
  `"regular"` and an explicit `sulfurSetScale(id, previewNearScale)` (default 1 = normal size).
- New config key `previewNearScale` (0.0625 - 10, default 1) to tune the size if a specific block
  still looks off.

### Fixed (4.0.0, stateful blocks and containers can be walked through too)

- **`blockBatchSetNear` was the wrong primitive.** It re-sends the whole window through the batch
  path, and a batch state string cannot carry block states: measured,
  `blockFakeResolve("minecraft:oak_stairs[weirdo_direction=2]")` returns the SAME network id as
  direction 0 while `blockFakeResolveNbt` honours it. That is why a registered staircase came back
  with the default facing, and why containers/signs lost their data (the re-send carries a block
  only). Only plain blocks were safe there.
- The window is now managed by CALL itself with `sulfurCreate` / `sulfurDestroy`:
  enter = `blockFakeClear` the cell + an invisible cube holding that block's item; leave (1.3x
  hysteresis) = destroy the cube + re-send the cell through the path that drew it (SNBT for states,
  `blockFakeSetBlockEntity` for containers/signs). Stairs keep their facing, chests keep their
  contents, and everything within the radius is passable.
- The ENTER scan is throttled to block-boundary movement (or a scene change); the LEAVE pass only
  walks the active cubes, so a 100k-cell preview costs nothing per tick.

### Fixed (4.0.0, the walk-through window only worked near the drop point)

- **The window never followed the player.** The ticker was only started for window/lazy previews, so
  a "full" preview registered the near set once (at build time) and nothing re-registered it while
  walking. Every mode now starts the ticker; `full` only refreshes the near window, not the cells.
- **The throttle re-registered on every tick** (its key included the window size and a 4 s fallback,
  and re-registering destroys and recreates the cubes). It now keys on a `contentVersion` that only
  moves when the scene changes, plus the player-distance rule.
- **Stateful blocks (stairs, slabs, ...) stay solid.** They are drawn per cell through SNBT, and the
  near layer re-sends its window through the batch path - a descriptor that differs at all showed up
  as a scrambled orientation. Plain blocks only, until the two paths are made byte-identical.

### Added (4.0.0, walk through the preview)

- **Nearby preview blocks can be walked through.** `blockBatchSetNear` turns the cells around the
  player (default 5 blocks) into passable, invisible sulfur cubes and puts the fake block back once
  the player leaves (1.3x hysteresis), so entering a big preview no longer stutters.
- The library **replaces the whole near set per call** and destroys the active cubes while doing it,
  so the window is sent as one payload and only re-registered when the player moved more than
  radius/2 or the scene changed; `previewNearCells` (default 512) plus the 12 KB argument budget cap
  it, and the payload is never assembled per cell.
- **Block-entity cells stay solid on purpose**: leaving the radius re-sends the bare block, which
  would wipe a chest's contents or a sign's text on the client.
- Config: `previewNearRadius` (0 = off), `previewNearInvisible`, `previewNearCells`;
  `/ca tools debug` reports the registration count and the library's `nearSets`.

### Fixed (4.0.0, undoing a chest no longer litters the ground)

- Replacing a container block makes the engine treat it as destroyed and spill its contents, so an
  undo (or a paste) over a filled chest left items all over the floor. Rewriting the block entity NBT
  first does NOT help: that write is itself the trigger (measured - the clear reported success and
  the items still appeared, and a window sweep was written before this was understood).
- The container is now emptied through the **container API** (`Block.hasContainer()` +
  `getContainer().removeItem()`) right before the block is replaced. Nothing is destroyed, so nothing
  drops. Only container cells pay for it; `silentContainerClear` (default true) turns it off.
- Considered and rejected: a global `doTileDrops` toggle (would rob other players), iListenAttentively
  (native-only, exposes no LSE binding here), and LSE's `onMobSpawn` (measured: it does not fire for
  container spills).

### Docs (4.0.0, paintings are out of scope)

- **Entity support (paintings, item frames, mobs) is not implemented and will not be.** The capture
  does contain actor identifiers (measured: `armor_stand` shows up in the captured bytes), but the
  LSE NBT API exposes no readable `structure.entities` entries, `/summon minecraft:painting` and
  `mc.spawnMob("minecraft:painting")` both refuse, and drawing a painting through the library's
  protocol entities crashed a real client while the server stayed healthy. Copy still records blocks
  and block entities; paintings are ignored, no warning.
- The one channel that DOES carry actors - `/structure save … true` + `/structure load … none
  true`, session-scoped - is written down with everything else in the new
  `docs/user/known-limitations.md`, so nobody has to rediscover it.
- The painting/entity code written while investigating was reverted; only the findings remain.

### Fixed (4.0.0, namespaced states, drop/pickup, waiting)

- **A namespaced state key was dropped, which is why a chest always faced one way.** `blockSnbtOf()`
  filters keys with `[A-Za-z0-9_.-]`, so `minecraft:cardinal_direction` (what a chest actually
  reports - measured) never reached the SNBT. With no states left the cell fell back to the batch
  path and the client drew the default orientation. The ':' is now allowed, the remap strips the
  namespace before its table lookup, `cardinal_direction` accepts the STRING form ("north"/...),
  and `direction` (doors, trapdoors, fence gates) uses the same four-way table.
- **Dropping or picking up an item no longer fires the held tool.** Both swing the arm, and the
  swing ticker read that as a left click on air. `onDropItem` / `onTakeItem` now claim the swing the
  same way a right click does.
- **"Operation in progress" is a message, not an exception.** It used to be `throw`n inside the
  command callback, so every impatient click printed a stack trace in the console (the tool path
  runs commands through `Player.runcmd`). It is a player-facing tip now, and the tool dispatch
  catches whatever else escapes.

### Fixed (4.0.0, selections and rollbacks across dimensions)

- **Changing dimension no longer breaks selecting.** A selection keeps one corner per click; a
  dimension change in between left the two corners in different worlds and `hasSetArea()` threw
  ("两点不在同一维度内"). Selecting and cancelling both go through it, so the area feature was dead
  until a relog. A stale selection is now `mixed` in `selectionState()`, dropped silently, and the
  next click starts a new corner A. `mc.listen('onChangeDim')` also clears the selection, resets the
  waiting-for-B flag, hides the wireframe and closes a preview that belongs to the dimension being
  left.
- **Undo/redo now wait for the preview teardown** (same rule as paste: restore packets describe the
  blocks a rollback is about to replace) and say so when the snapshot's dimension is not the one the
  player is standing in - undo replays the RECORDED area, so it was correct but invisible.
- Snapshots without a dimension (written before dimensions were tracked) are normalised to the
  Overworld with one warning instead of waiting out the chunk gate.

### Fixed (4.0.0, the Nether / End residues)

- **The dimension was read from the wrong object.** LSE exposes `dimid` on `IntPos`/`FloatPos`
  only - a `Player` has no such field - so `Number(player.$.dimid ?? 0)` silently pinned every
  preview to the Overworld. That is invisible there and fatal elsewhere: the teardown asked the
  Overworld for Nether/End coordinates, got `null` for every cell and restored nothing
  (measured: `还原: 请求=1471 可读=0 不可读=1471`, so the previews stayed on screen).
  `common/Dimension.dimensionOf()` now takes it from `pos.dimid` (falling back to the selection
  area, treating LSE's `-1` as unknown) and is used by the scene, the chunk-change key and the
  paste repaint.
- A restore that cannot read a SINGLE cell now logs an error with the dimension, the counts and
  three sample coordinates instead of quietly doing nothing.

### Fixed (4.0.0, pasting right after adjusting the preview)

- **A paste no longer races the preview teardown.** Restore packets carry the block the world had
  when they were built - i.e. BEFORE the paste - so a paste that starts while they are still queued
  lands them on top of freshly pasted cells and the structure looks torn until a relog reloads the
  chunk. Both paste entry points (the preview wand and `/ca paste`) now cancel the preview and
  await `PreviewScene.flushCleanup()`, which waits for the deferred tasks AND the library queue
  (4 s cap, then it proceeds and logs a warning). `/ca tools debug`-style log line:
  `粘贴前等待清理完成 Nms`.

### Fixed (4.0.0, the 16 KB packed-string truncation)

- **This is the root cause of both the preview holes and the cancel residue.** LSE truncates the
  string it hands to `ll.import` at roughly 16 KB, and `PACK_MAX_BYTES` was 512 KB, so any batch
  bigger than that lost everything past the cut - silently, on both the draw and the restore path.
  Measured with `blockBatchSelfTest` against our own payload: 1295 changes out of 5981 packed,
  1192 of 1516, while a 14-cell preview parsed all 14. The gap grows with the structure, which is
  exactly what was reported ("small builds are clean, big ones leave almost everything behind").
- `PACK_MAX_BYTES` is now 12 KB (a 25% margin), so a large payload is split into several verified
  segments; `CLEAR_CHUNK` drops to 1024 for the same reason. A unit test pins the budget below the
  measured limit and asserts every cell survives the split.

### Fixed (4.0.0, cells the packed format cannot carry)

- **Restore now reports (and repairs) entries the batch format refuses.** `packCells()` silently
  drops a cell whose descriptor contains `;` (or has non-integer coordinates), and
  `restoreDetailed()` ignored `packed.skipped` while still reporting "restored 1506" - the live
  selfTest made it visible: `请求=1506` but `changes=1272, bad=1`, so 234 cells never received a
  packet and stayed on screen. Such cells are now returned as `direct` and restored one by one
  through `blockFakeSet`; `restored` only counts entries that really made it into a segment.
- `/ca tools debug` and the cancel report show the library's `dropped`/`bad` counters and a
  `单格补发 N 格` figure, which is what turned this from a guess into a measurement.

### Fixed (4.0.0, a clear is not a confirmation)

- **A restored cell is no longer forgotten.** `markCleared` removed the cell from `everApplied` as
  soon as the restore packet was SUBMITTED. The library queues batches and can drop one, so a
  dropped clear left a fake block that nothing remembered (measured: a session that sent 2412 cells
  reported `ever=1624` at cancel - 788 cells had been forgotten). Clears now only drop the cell from
  `applied`; `everApplied` keeps it, so a cancel restores a superset of everything the preview ever
  drew (re-sending the real block is a no-op packet). The set is capped at 200k cells for very long
  sessions.
- Together with the plan-level registration this makes the cancel independent of clear reliability,
  which is the last known source of leftovers.

### Fixed (4.0.0, cancel covers the whole plan)

- **A cancel now restores every cell the plan asked for**, not only the cells whose packet was
  confirmed. The ledger only recorded successful draws, so any draw path that missed its mark (the
  per-cell block-entity path, which grew a lot once banners serialised correctly) left fake blocks
  that no teardown knew about - the residue appeared exactly after that change even though the
  cancel code itself was untouched. `enqueue()` now registers every desired cell in
  `everApplied`, and the teardown restores that superset (re-sending a real block is a no-op).
  Measured in the headless suite: the same cancel reports 572 cells instead of 0.
- `FakeBlocks.restoreDetailed()` reports WHICH cells were restored; cleanup removes exactly those
  instead of slicing by count (cells whose block cannot be read used to shift the slice and drop
  the wrong positions while reporting success). Unreadable cells are counted separately
  (`不可读 N 格`) so it cannot retry forever.
- `debugMod` adds `[preview] 取消: applied/stale/ever/清理/队列` so the next report shows whether
  the ledger and the plan agree.

### Fixed (4.0.0, residue after moving or rotating the preview)

- **A rebuild inherits the previous ledger instead of clearing it.** Every nudge/rotate rebuilt the
  scene with `clear()` and discarded the pending teardown, so cells of the old footprint that were
  no longer part of the plan had nobody left to clear them - the cancel only knew the last scene's
  cells (measured: 1719 cells cleaned out of ~9000 drawn). `detachScene()` now stops the timers and
  the queued jobs without sending a packet and hands `applied/stale/everApplied` to the new scene, so
  the diff clears whatever left the footprint and a cancel covers everything the preview ever drew.
  Inheriting is refused across dimensions/players (`CleanupGate.canInheritLedger`), where the old
  cells are restored instead.
- `/ca tools debug` reports `… · 继承 N 格` so the inherited footprint is visible.

### Fixed (4.0.0, cancel left half a preview behind)

- **Cancelling during a build no longer leaves fake blocks on the client.** A batch larger than
  `previewBatchImmediate` is queued inside HologramLib and drains over several ticks; the old
  teardown restored immediately, so those queued batches landed afterwards and drew the preview
  back. Cancel now stops feeding first (`BatchSender.cancelOwner("preview:<xuid>")`), the restore
  waits for the library queue to drain (3 s cap, `CleanupGate`) and is sent twice so a packet
  already in flight cannot survive.
- Teardown bookkeeping is visible: `/ca tools debug` prints `取消清理: 待处理 / 累计 / 等队列 /
  二次还原 / 超时放行 / 失败`, which is what makes a future residue report diagnosable.
- Cleanup also restores in the scene's own dimension now (it silently defaulted to dimension 0).

### Fixed (4.0.0, block entity payloads: banners, signs, chests)

- **Banners keep their colour and patterns.** `snbtOf()` converted the parsed tag tree through
  LSE (`toLseTag(...).toSNBT()`) and came back with an EMPTY string whenever the payload contained
  a list of compounds - which is exactly what a banner's `Patterns` is. The caller treated the
  empty string as "no payload" and dropped it, so the copy looked like it had lost the banner data
  (a chest, whose `Items` is an empty list, converted fine and hid the pattern). Measurement:
  banner payload 0 characters, chest 84, from the same capture. SNBT is now written by
  `NbtCodec.snbtWrite()` from our own tree (98 characters for the same banner), and the paste path
  writes payloads via `NBT.parseSNBT(snbtOf(tag))`.
- A pasted banner is no longer lost: with the payload writable, the block survives and keeps
  `Base` + `Patterns` (new live gates `ca.bannerCopyAudit` and `ca.bannerRoundTrip`).

### Fixed (4.0.0, rotation of the preview and block-entity blocks)

- **The preview now rotates the block STATES, not just the cells.** Both extraction call sites pass
  `0, "none"` and the real angle is applied later by `planCells()`, so the remap added at extract
  time always used 0 degrees - which is why 0 degrees looked right and 90 degrees did not. Blocks
  now carry their palette entry and `planCells()` re-derives `id`/`blockSnbt` from the actual
  degrees/mirror (one conversion per palette item, not per cell).
- **Block-entity blocks are created with the right API.** The fallback used
  `mc.setBlock(x, y, z, dimid, name, data)`, which LSE does not have: the call threw, the throw was
  swallowed, and the cell silently stayed air - a pasted banner could simply vanish. It now uses the
  documented `mc.setBlock(pos, name, tileData)` / `mc.setBlock(pos, nbt)` forms and logs once when
  creation fails.
- `/ca tools debug` prints the first block-entity payload of the live preview and whether it carries
  `Patterns`/`Base`/`Text`, plus a new live test (`ca.bannerRoundTrip`) that seeds a patterned
  banner, copies and pastes it, and reports `written / dstType / dstStates / dstBE` when it breaks.

### Fixed (4.0.0, batched vs immediate writes)

- **Block states and block entity contents finally reach the client.** A batch larger than
  `previewBatchImmediate` (default 256) is QUEUED and drained over several ticks, so the immediate
  `blockFakeSetNbt`/`blockFakeSetBlockEntity` corrections sent right after it were overwritten by
  the incoming base-state blocks: the counters said "states 513 / entities 2 pushed" while the
  stairs stayed default and the banners stayed black. Cells that carry states or a block entity are
  now excluded from the batch and drawn per cell (body, then payload), which is also fewer writes
  overall (one write per cell instead of two).
- **Paste repaint uses the real player API.** `PasteSync` called `mc.getPlayers()`, which LSE does
  not have - the defensive guard turned it into an empty array, so every paste reported
  "pushed 0" with no error. It now uses `mc.getOnlinePlayers()` and reports
  `在线 / 同维度 / 半径内 / 推送 / 失败` separately.
- `/ca tools debug` adds a probe that resolves the FIRST real `blockSnbt` of the live preview
  through `blockFakeResolveNbt` and compares it with the bare-name id, so "the states are in our
  SNBT but the library ignores them" can be told apart from a timing problem.

### Fixed (4.0.0, rotated pastes)

- **Rotating or mirroring a structure now turns its block states.** `transformLayout()` only
  permuted the cell indices and carried the palette as-is, so a rotated staircase kept its original
  facing while the shape turned - the "stairs are scrambled after a rotated paste" report. A
  shared table (`StateRemap`) remaps `weirdo_direction`, `cardinal_direction`,
  `facing_direction`, `torch_facing_direction`, `pillar_axis`/`axis` and
  `ground_sign_direction` for both the paste and the preview; unknown keys are left alone.
- **Preview overrides stay in one family.** The state overlay used `viewBlockById`, which writes a
  PERSISTENT per-player override (survives chunk reloads and re-joins, only `viewClearBlock` /
  `viewClearAll` remove it) - the teardown only sent `blockFakeClear`, so those cells became ghosts
  the user had to relog to clear. State cells now go through `blockFakeSetNbt` (packet family, same
  as the rest of the preview), and `viewBlockById` is no longer bound at all.
- **The startup log prints the build**: `build <version> (<git sha>) <built-at>`, also shown by
  `/ca tools debug`. Screenshots can finally be attributed to a commit (this round started with two
  screenshots from an older deploy).

### Fixed (4.0.0, HologramLib 450)

- **Stairs, fences, logs, waterlogged blocks keep their state in the preview.** Measured on
  26.60.8: the library's state STRING resolver (`blockFakeSet`/`blockBatchSet`) returns the block's
  BASE network id (`weirdo_direction=2` and `=0` give the same number), while its SNBT resolver
  honours the states. State-carrying cells are therefore resolved from SNBT and overlaid with
  `viewBlockById` (bounded to 2048 cells per preview); the batch path still draws the bodies.
- **State strings must use unquoted keys.** The library parser trims the key but only unquotes the
  value, so the old `["weirdo_direction"=2]` form was refused outright.

### Changed (4.0.0, HologramLib gate)

- The dependency is now gated on the **exported API surface**, not a release number (442- and
  450-export builds both report ABI 1.37.0). Minimum supported: **v26.60.8 / v26.51.11**; the
  version exports (`holoLseVersion`/`holoAbiVersion`) are logged, and a missing export only
  disables the feature that needs it, with one warning.

### Docs (3.9.5-beta1)

- **Project rules for agents are now in `AGENTS.md`** (outside the AOCI-managed block): docs-first
  debugging, the verified platform facts, HologramLib integration limits, and a hard release gate.
- **`docs/dev/pitfalls.md`** is the incident ledger (symptom -> root cause -> fix -> how to verify),
  built from the two long debugging sessions; **`docs/dev/release.md`** documents the release process.
- **`npm run check:version`** (also wired into CI) compares `package.json`, `tooth.json` and the
  newest `CHANGELOG` section; an untagged version only warns, a disagreement fails. This is what
  caught the drift where the tree said 3.9.x while the last tag was still v3.1.0.

### Changed (4.0.0, build 36)

- The per-burst `[CALL][preview] +N 批 / +M 格` line is `debugMod`-only. It printed about once per
  second during a normal preview session, which is noise on a production console; the counters are
  still kept and the line comes back the moment `debugMod` is on.
### Fixed (4.0.0, build 35)

- **`/ca area a|b` with no coordinates now selects the block UNDER the feet.** It used
  `player.pos` minus one, which is the cell the body occupies; the block beneath it is one lower.
  The rule is now "walk down from the player and take the first non-air block" (up to 3 cells),
  which also works for a hovering player and for slabs/stairs - and it replaced
  `getBlockStandingOn()`, which on this build answers the FEET cell (measured in the live probe).
- Air clicks (selection/preview/paste wands) use the same rule, so "click the air = the block under
  my feet" is now literally true (live: `call area a 28 37 28` for a player at y=38).
### Fixed (4.0.0, build 34)

- **Every wand was one block off for NEGATIVE coordinates.** Measured with a probe command: LSE
  returns a position argument as the block CENTRE (`x + 0.5`), and `ParamType.BlockPos` truncates
  that toward zero - so `-44` arrived as `-43`, `-0.5` as `0`, `-99.5` as `-99`, while positive
  coordinates were fine. That is the whole "points are one block off" report: the world is at
  negative Z, so every tool that takes coordinates (selection, preview, paste, fill, ...) moved by
  one block. All position arguments are now `ParamType.Vec3` and the centre is FLOORED back to its
  cell (`CACommand.normalisePositions`), which is correct for both signs.
  Measured: `1376 179 -44` -> `1376.5 179 -43.5` -> floor -> `1376 179 -44`.
- Dropped the experimental "correct the block from the hit point" step: it turned left clicks (where
  the hit point IS the block position and the face is stale) into `y - 1`.
### Added (4.0.0, build 33)

- `ca.areaSetFromCommand` (live): the area handler is fed the exact args the command parser
  produces (`IntPos(1376,179,-44)` / `IntPos(1377,179,-45)`) and the stored corners are asserted to
  be verbatim. Together with the click log and the geometric correction this closes the whole
  chain: event block -> clicked block -> `${block.pos}` -> command -> stored area.
### Fixed (4.0.0, build 32)

- **The point is derived from the HIT POINT when the event block disagrees.** A click on a face
  reports a point on that face's plane; the reported block is *supposed* to be the clicked one, but
  when it is the neighbouring cell every wand lands one block off (the repeated report: clicking
  z=-45 sets z=-44). Geometry decides now: step 1e-3 INTO the block from the face plane and floor
  (`side` 0/1/2/3/4/5 -> down/up/north/south/west/east). A correction is logged under `debugMod`
  (`block corrected by hit point: event=… -> …`), so the engine's behaviour is visible instead of
  argued about.
### Changed (4.0.0, build 31)

- The selection label now carries the box origin: `2×1×2(4) @1376,179,-45`. A box that looks
  shifted can then be checked against the numbers that drew it straight from a screenshot.
- Verified against the library (`ca.shapeBoxAnchor`): `shapeCreateBox(10,20,30, 12,21,32)` reports
  its location as `[11,20.5,31]`, i.e. the CENTRE - so the "same size -> shapeSetLocation(centre)"
  move path in Wireframe is correct and the drawn box follows `start`/`end` exactly.
### Fixed (4.0.0, build 30)

- **The `${posf}` migration never ran for players whose configs still used it.** It was wired into
  the "binding missing" branch, but a `${posf}` binding resolves perfectly - it just selects the
  FACE plane, so the second click landed one block higher/off (`posf=1377.58,180,-44.35` for the
  block at `1377,179,-45`). The rewrite now runs on the first click of every session (once per
  player) and persists the settings.
### Added (4.0.0, build 29)

- `debugMod` now logs the commands a click resolves to (`[CALL][tool] cmd call area a 1376 179 -44`),
  so a "one block off" report can be split into *the command was wrong* vs *the drawing was wrong*.
- `/ca tools debug` prints the selection state (display mode, wireframe anchor, stored `start -> end`).
- `ca.areaLens` (live) pins the exact pair from the report: A=(1376,179,-44), B=(1377,179,-45) must
  normalise to lens 2x1x2 with z -45..-44 - i.e. the stored box is correct even when the second
  click is the minor corner.
### Fixed (4.0.0, build 28)

- **Clicking air targets the block under the feet again** (no crosshair). The view ray was added
  while chasing the one-block offset; the operator's rule is simpler: air click = the block you
  stand on, then the cell below it, then the body cell.
- `/ca tools debug` now prints the selection state: display mode, the wireframe anchor /
  placeholder block, the stored `start -> end` and the wireframe counters - so a box that looks
  shifted can be checked against the numbers that produced it instead of a screenshot.
### Fixed (4.0.0, build 27)

- **"All wands are one block off" was a `${posf}` binding, not the click routing.** `posf` is the
  raw click point and it lies on the FACE plane: clicking the +Z face of the block at
  z=-43 gives z=-42, so a binding like `call area a ${posf.x} ${posf.y} ${posf.z}` (which the old
  configs used) selected the neighbouring block. Those bindings are now rewritten to `${pos.*}`
  once - in `default.items` at startup and in every player's own settings on their next click -
  and `${hit}`/`${hitf}` keep the raw point under a name that cannot be confused with the block.
- The click diagnostic (`debugMod`) now logs EVERY routed click, not just the preview paste:
  `[CALL][tool] path=block|air item=… block=x,y,z type=… posf=… side=…`. It printed nothing before,
  which is why the report could not be answered from the console.
### Changed (4.0.0, build 26)

- **The paste wand is now the only way to confirm a preview.** It answers BOTH buttons on both
  targets - a click on a block and a click on air, left and right - because the left side already
  fell back to the right binding. With a preview open the click pastes at the previewed position
  (rotation, mirror, pivot and the manual offset) and ends the preview; with no preview it behaves
  exactly as before. The interception sits before binding resolution, so a renamed wand still works.
- The preview wand no longer confirms on sneak+right (the worst gesture to perform while flying);
  it points at the paste wand instead, at most once every 30 s. `/ca preview confirm` and the menu
  entry keep working.

### Fixed (4.0.0, build 26)

- **Every wand acted one block off.** A single click can reach the plugin twice - the block event
  (correct coordinates) and the swing/use heuristic - and the second one ran the tool against the
  block at the player's feet, overwriting the result. The air path now yields for 300 ms after a
  block click, so a click that hit a block is handled once, on that block.
- The air path also takes the block under the crosshair first (`getBlockFromViewVector`), before
  the standing block and the feet cell: even when only the heuristic fires, the point is the block
  the operator clicked.
- `debugMod` logs `[CALL][tool] path=block|air|preview-paste item=… source=…` so a routing report
  can be answered with evidence instead of a guess.
### Fixed (4.0.0, build 25)

- **Clears are queued before sets ("先清理再移动").** `diffPlacement` emits sets first, so a move
  drew the whole new window (up to 12 chunks of sets) before restoring the old one - and a restore
  that arrives after its cell was re-drawn loses. The pump now always drains clears first, which is
  the ordering the library author pointed at.
- Restores keep going through the SET path (see build 24): the library's clear reports failure on
  this build even for cells that were faked a moment earlier
  (`restored 8/8 via the set path (blockBatchClear=false)`).
### Fixed (4.0.0, build 24)

- **BlockBatchClear is not usable here: a clear is now sent as "set the real block".** The
  library's clear paths (`blockBatchClear` / `blockFakeClear`) report failure - their bodies are
  validated one by one and only packets that really went out are counted - and a refused clear is
  a permanent ghost (the log showed `回退 N 欠清 20` growing with `库队列 0 包`, i.e. every single
  clear refused). Restoring now reads the block the world has at the cell and pushes it through
  the SET path, which is the one that demonstrably reaches the client; verified live:
  `restored 8/8 via the set path (blockBatchClear=false)`.
- Cells whose chunk the server does not have stay owed (`stale`) and are retried (and restored on
  teardown), so a preview can no longer leave anything behind.
- The queued-cleanup path (offline player / refused clear) also restores through the set path
  instead of `viewClearBlock`, which only reverts `viewBlock` overrides.
### Fixed (4.0.0, build 23)

- **Ghost blocks survived moving, switching and cancelling a preview.** `maybeResend()` cleared the
  whole `applied` map whenever the player crossed a chunk boundary (or the heartbeat came due).
  That map is the only memory of what the client is showing, so every cell that left the window
  afterwards was never cleared again - it stayed until the player relogged - while the entire
  window was re-sent on every crossing (the log showed ~1,000,000 cells for a 12,000 cell window).
  Re-sends are now ADDITIVE (`resendRequested`, rate limited to one per 1.5 s, skipped above 30k
  cells) and never touch the ledger.
- **A clear we cannot confirm is now owed, not forgotten.** Failed clears move to a `stale` set
  that the pump services before anything else, and teardown clears the union of
  `applied + stale + everApplied`, so cancelling cannot leave anything behind even after a
  dropped packet. The rules live in the new `structure/GhostLedger.ts` and are unit-tested.
- Submissions pause while the library queue is deeper than `previewBatchQueueMax` (default 24
  packets) instead of flooding a client - a dropped packet is exactly what produced permanent
  ghosts before.
- The burst log now reports THIS burst (`+N 批 / +M 格`) plus `重发 / 回退 / 被拒 / 跳过 / 欠清`,
  so the re-send loop is visible immediately instead of being hidden inside a cumulative counter.
### Changed (4.0.0, build 22)

- **The preview now sends through HologramLib's batch fake blocks (`blockBatch*`).** One call
  carries up to 1024 cells and the library merges them per sub-chunk into `UpdateSubChunkBlocks`
  packets, so a big window no longer costs one native call and one packet per cell. Measured on
  the test server: **4 096 cells -> 8 packets in 2 ms** (the per-cell path emitted 4 096 packets),
  with the library's own counter as evidence.
- Submissions are paced by `BatchSender` (`previewBatchPerTick`, default 6) so CALL stays inside
  the library's global 8-packets-per-tick budget instead of monopolising it; small deltas
  (rotate / nudge) go through `immediate=true` and skip the framing entirely.
- Teardown is a single `blockBatchClear` instead of one `viewClearBlock` per cell.
- Client chunk reloads drop fake blocks, so the window is re-sent when the player crosses a chunk
  boundary, changes dimension, or every `previewResendSeconds` (default 20 s).
- Everything degrades to the old per-cell path: no `blockBatch*` exports, a rejected payload or
  `previewBatchMode: "off"`. `/ca preview info` reports the backend (`viewBlock+batch`), batches,
  cells and the library queue; `/ca tools debug` shows the batch API availability + self-test.
### Fixed (4.0.0, build 21)

- **data/nbt no longer grows a folder per server player.** The layout migration called
  `StructureStore.prepare()` (mkdir) for every xuid it found in the old config and only afterwards
  looked for slice files, so a server collected one empty folder per player who ever logged in,
  permission or not (the test server had 68 folders, 66 of them empty). Migration now checks for a
  real slice file first, and startup prunes folders that contain no `.mcstructure` at all
  (`_legacy`, `_orphan` and `public` are never touched). Verified on the test server:
  "清理空目录 66 个", leaving only the two folders that hold structures.
### Fixed (4.0.0, build 20)

- **"这个工具还没有绑定" appeared at random.** Bindings are keyed by the item's display name, and
  `matchBinding` only accepted an exact name or the unnamed entry - so a renamed tool (anvil), a
  name that drifted across a config migration, or a stray line break from the item NBT made the
  wand a dead item. Resolution is now: exact name -> unnamed entry -> first entry of that type,
  the name is trimmed, and the warning (which now names the type) only appears when the type has
  no bindings at all.
- **Switching tools could start a preview with nobody clicking.** Left clicks are inferred from
  HologramLib's swing counter, and a right click / block place also swings the arm; the leftover
  delta was later dispatched against whatever item was in hand by then (the preview wand).
  `SwingWatcher.noteHandled()` now marks every use/place as explaining the swing, and a change of
  the held item between two polls re-baselines instead of firing. Counters show up in
  `/ca tools debug` (已触发 / 吞掉右键 / 吞掉切换).
### Fixed (4.0.0, build 19)

- **Block entity data was never READ, so banner patterns could never survive a paste.** Parsing a
  real captured structure showed the compound walk inside `structure` stopping right after
  `palette` - the parsed tree had only block_indices/entities/palette while the bytes clearly
  contained `block_position_data` (33 payloads in a 64 KB banner structure). The codec now anchors
  on the name and parses that compound directly, then `transformLayout` moves every payload with
  its block and placement applies it through `Block.getBlockEntity()` across batch ticks (a fresh
  block entity is not reachable in the same tick; `Block.setNbt` drops the extra keys).
- `BlockView` no longer sends stateful ids without checking: the string IS accepted by the library
  (`viewBlock` returns true) but the client still draws the default variant, i.e.
  `Block::tryGetFromRegistry` ignores the descriptor. Preview stair orientation therefore stays a
  library limitation until `viewBlock` accepts a network id or a states payload.
### Fixed (4.0.0, build 18)

- **The preview now sends block states.** `SurfaceExtract` only stored the palette NAME, so every
  stair faced the same way and fences/doors lost their variants while the paste (which writes
  `name` + `states`) was already correct. The override id is now a full descriptor, e.g.
  `minecraft:stone_stairs["weirdo_direction"=2,"upside_down_bit"=false]` - verified against
  HologramLib, which resolves it through `Block::tryGetFromRegistry` - with a fallback to the
  bare name when a client rejects a state.
- **Block entity data is parsed and applied on paste.** `StructureLayout` now reads
  `structure.block_position_data` (banner patterns, chest contents, sign text), `transformLayout`
  moves it with its block for every rotation/mirror, and placement writes it through
  `Block.getBlockEntity()` after verifying the block actually appeared (`Block.setNbt` reports
  success but drops extra keys). Needs an in-game check with a patterned banner.
- Banner/sign/chest contents still cannot be shown in the PREVIEW: the per-client block override
  takes a block id only. Documented in docs/user/tools.md.
### Fixed (4.0.0, build 17)

- **A freshly placed preview was cancelled by the previous one's timer.** `set()` builds a new
  state object and overwrites the old one, but the old auto-cancel `setTimeout` was left armed;
  it fired at its original deadline and cancelled whatever preview was current - the countdown
  read 50 s and then "预览已超时取消" appeared. The old timer is now cleared when the state is
  replaced, and the timeout callback only acts when its own state is still the current one.
### Fixed (4.0.0, build 16)

- **A left click on the preview wand left the ghost full of holes.** A left click re-sets the
  anchor, and `set()` always rebuilt the scene; `PreviewScene.build()` tears the old scene down
  by pushing its cells onto an asynchronous cleanup queue, and that queue kept restoring the
  real blocks *after* the new scene had drawn the same cells - holes in whole bands. Moving a
  preview now takes the diff path (`PreviewScene.canMove()` + `move()`) instead of rebuilding,
  and `build()` discards that player's stale cleanup tasks before clearing.
- Rotation / mirroring keep their incremental path, so they were never affected.
### Fixed (4.0.0, build 15)

- **HologramLib shape-fix release adopted.** 26.60.6 / 26.51.10 make the remove packet a bare
  network id (`DebugShape::mType` became optional), so `shapeDestroy` finally clears the shape on
  the client. CALL now locks that minimum (`HOLO_FIX_REMOVE_26_51 = 26.51.10`,
  
  `HOLO_FIX_REMOVE_26_60 = 26.60.6`, teeth dependency `>=26.51.10`) and only falls back to the
  "park the shape below the world" workaround when the installed library is older - the
  `wireframeParkBeforeDestroy` option now defaults to `false` and merely forces it on or off.
- Both test servers upgraded (26.51.10 / 26.60.6); start-up reports the version as before.
- `docs/user/tools.md` and `config.md` state the new minimums.
### Fixed (4.0.0, build 14)

- **Clicking air targeted the cell the body occupies, one block above the floor.** The
  selection/preview/paste point of an air click is now the block the player stands ON
  (`player.getBlockStandingOn()`), falling back to one below the feet cell, then to the view
  ray, then to a stand-in - so flying over nothing still works.
### Fixed (4.0.0, build 13)

- **A cancelled preview left its box and label on screen.** Verified with `/ca tools debug`: after
  cancelling, the plugin tracked 0 keys and the library held 0 shapes, yet the client still drew
  them - clients ignore the library's remove packet but DO honour updates. Shapes are now moved
  512 blocks below the world and re-sent before `shapeDestroy`, so a cancel (or a rebuild after a
  size change) clears the screen immediately. New option `wireframeParkBeforeDestroy` (default
  true) documents the workaround and can be turned off once the library removes shapes properly.
### Fixed (4.0.0, build 12)

- **Reverted the wireframe lifetime, which was my own regression.** Build 11 set
  `shapeSetDuration` on every shape after concluding the library's remove packet was ignored.
  That was wrong: with a lifetime attached, the client keeps the shape and stops honouring
  `shapeDestroy`, so *every* rebuild left a ghost - the plain destroy path used by build 8 had
  been working all along. `wireframeTtlSeconds` is back to `0` (off), an existing `5` from
  build 11 is migrated back to `0`.
- **Boxes are moved instead of rebuilt**: a preview nudge or an anchor move keeps the same
  footprint, so the box is now moved with `shapeSetLocation` + `shapeUpdate` - no new shape is
  created, therefore no ghost can appear. Verified: 4 nudges keep the same box id.
- Labels are still rewritten in place (never recreated), which fixed the stacked text earlier.
- `/ca tools debug` shows the lifetime state plus per-key in-place-move / text-reuse counters.
### Fixed (4.0.0, build 11)

- **Wireframe ghosts are gone, and the cause was in the library, not in our drawing.**
  `shapeDestroy` erases the shape server-side and returns true, but the packet it sends
  (`makeRemoveShape`) carries only the network id - no `mType` - and clients ignore it, so every
  re-render left the old box AND its label on screen. Our shapes now carry a client-side
  lifetime (`shapeSetDuration`, default 5 s via `wireframeTtlSeconds`) and are re-armed every
  ttl/2, so leftovers expire on their own while live shapes stay put.
- Preview labels are no longer recreated: the same text shape is moved and rewritten
  (`shapeSetText` + `shapeSetLocation` + `shapeUpdate`), so rotating the preview cannot stack
  labels. Cancelling a preview fades the shapes out in 0.2 s instead of relying on destroy.
- `/ca tools debug` reports the ttl and each key's text-reuse count.
### Fixed (4.0.0, build 10)

- **A left click on a block also fired a "click on air", which rewrote the selection at the
  player's feet** - the reported "选区往外多一格". The dedupe window compared the block event
  against the time the swing was *detected* (up to `toolSwingPollMs` later), so a block click
  always looked like a miss. The window now spans the previous poll, plus a hard guard that
  ignores any swing within `pollMs + 100ms + 50ms` of a real block/entity click.
- Lossless clicks: a poll that sees `delta > 1` now dispatches every click (max 3), instead of
  collapsing them into one.
- Wireframe cleanup is no longer silent: if `shapeDestroy` fails the box is hidden with
  `shapeRemove` and a warning names the key and id. `/ca tools debug` now prints every tracked
  shape (key, box id, label id, still-exists) and the library's total shape count, and the new
  `wireframeResetAll` option (default off) can hard-reset the library when something is stuck.
### Added (4.0.0, build 9)

- **Tools respond to a click on air, left and right.** Right-click on air was already wired
  through `onUseItem`; left-click had no event at all (LSE only reports left clicks that hit a
  block or an entity). HologramLib 26.51.9 / 26.60.5 counts every client swing, so CALL polls
  `swingCount` and treats a swing that is not followed by a block/entity click within **100 ms**
  as a click on air.
- Air clicks target the block at the **feet** (`player.pos` is one block above them, which is
  why things used to land at head height), falling back to the view ray, then to the player's
  own position for bindings that need no coordinates.
- The adjust wand derives a face from the view when there is none to hit: look up and it moves
  up, look east and it moves east (sneak reverses, as before).
- **HologramLib version gate**: `HoloCompat` reads the installed version (manifest +
  `holoApiVersion` + a real `swingCount` probe) and warns once when it is missing or older than
  26.51.9 / 26.60.5 (26.51.8 is withdrawn), naming the exact requirement. Air-left is disabled
  in that case; nothing else degrades. `/ca tools status` prints the version line.
- New config keys `toolAirClick` (default `true`) and `toolSwingPollMs` (200 ms, 100-1000),
  schema `version` 2. `tooth.json` now depends on `github.com/Ieckseyr/HologramLib >=26.51.9`.
### Changed (4.0.0, build 8)

- **Removed the `texturepack-required` warning.** It claimed clients might not receive the
  resource pack (blank item icons) unless the flag was `true` - that was wrong: the pack is
  downloaded regardless, and the advice came from a time when the addon itself failed to load.
  `/ca tools status` still shows the flag, neutrally, for diagnostics.
### Changed (4.0.0, build 7)

- **The tools respond to a right-click on air.** Only `onUseItemOn` was wired, so the menu and
  the copy wand required a block under the crosshair. `onUseItem` is now listened to as well
  (ignored within 250ms of a block click to avoid double handling) and targets what the player
  looks at, then the block under their feet, then a stand-in at their position - which is
  enough for position-free bindings such as `call menu` and `call copy`.
- **Loose files in `public/` are no longer published.** The README and the docs claimed a bare
  `.mcstructure` in the root would work; it did not, and clicking it only produced a console
  error. Such files are now ignored, and opening the menu says how many were found and where
  they must go (`public/<名字>/`). Loading one by id answers with the same explanation.
### Fixed (4.0.0, build 6)

- **The menu's 提交 button produced a syntax error for names with spaces.** The form built
  `call load 233 FF 黑黑 _ 啊啊_ 641 136 6019 ...` unquoted, so the parser read `233` as the id and
  `FF` as a coordinate. Every id interpolated into a command (load / delete / public / private)
  now goes through `quoteArg()`, which wraps it in double quotes - the same form that works when
  typed by hand.
### Fixed (4.0.0, build 5)

- **A failed load no longer reports success.** The callback ran inside `StructureService.load`
  before the promise resolved, so the counter was still 0 when the message was printed; the
  failed slice count is now handed to the callback directly.
- **`data/nbt/public/` is read-only for the plugin**: `NBTService.del()` refuses any path under
  it and logs the attempt, so a structure can only disappear if the operator removes it.
- `/ca publiccheck` prints every public structure with per-slice presence and a
  "N 个正常 / M 个缺片" summary; `/ca publicreload` forces a rescan after the files change.
- Names with spaces work as before in chat: quote the argument (`/ca load "黑黑 FF 好好" 100 64 100`).
### Fixed (4.0.0, build 4)

- **A public folder that holds slices of two structures loaded nothing at all.** The folder
  `完整结构test测试` contained `mw53lhiyuc_0_0/_1_0/_2_0` plus a stray `mw53oq4jl7_0_0`; the scan
  produced two entries with the same display name, the name->slice-id alias kept only one of
  them, and the size came from the other - so every slice was looked up under the wrong id.
  Entries now carry a unique id (`folder` for the biggest structure, `folder~sid` for the
  extras) and the alias is keyed by that id.
- **A failed load still reported success.** `StructureService.load()` returns the number of
  failed slices and the caller ignored it; it now reports "加载失败：N 段切片没有读出来" with the
  folder it looked in, and the per-slice console spam is gone.
- `/ca publicdebug <id>` prints the scan result, the resolved slice id and the absolute path of
  every slice with a present/missing marker.
### Fixed (4.0.0, build 3)

- **`/ca load` on a public folder crashed with `Cannot read properties of null (reading
  'area')`**: `load()` still read the structure out of `saveList`, which never contains a
  public folder. It now resolves through `StructureService.getStructureById()` (own saves /
  published registry / `data/nbt/public`) and answers with a readable message when the id
  really does not exist.
- **`/ca delete` refuses public folders instead of failing obscurely**: it resolves through
  `findId` and answers "公共结构是只读的" without touching a file. A bare `/ca delete` now
  prints the usage line rather than the vanilla "unexpected argument".
- Both of the above were patches that had silently not been applied: the files use CRLF and
  the `String.replace` anchors were LF-only. New `tests/unit/wiring.test.mjs` reads the
  sources and fails when a critical integration point is missing, so that cannot happen again.
### Fixed (4.0.0, build 2)

- **Opening the public structure list crashed the whole form** (`StructureForm.ts:169`): the
  code did `Players.getCAPlayer(author).$.name`, but structures scanned from
  `data/nbt/public/` have `author = "public"` and any author may be offline, so `.# Changelog

All notable changes to CALL are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

This is a community fork of [superx101/CALL](https://github.com/superx101/CALL), which
is no longer maintained upstream. The 3.0.0 line targets **LeviLamina 26.51.x** with
**LegacyScriptEngine (nodejs) 0.22.4**.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the platform behaviour these
fixes are based on.

 threw and
  the form was never sent - the menu looked unresponsive. Authors now go through
  `StructureService.authorLabel()`, which always returns a string (localised "Public" / the
  player name / the last known name / the raw id).
- Public structures are identified by their **folder name** (unique on disk) instead of the
  internal slice id, so two copies of the same build no longer collide in the list, and
  `load`/`getAllNBT` translate the display id back to the slice id before reading files.
- Multi-slice public structures now report their real size (slices are grouped by
  `<id>_<x>_<z>`), and an incomplete set is refused with a readable message instead of
  silently pasting part of the building.
- One malformed row can no longer take the whole structure list down (per-row guard + log).
 - 2026-11-07

### Changed

- **Configuration is JSONC and keeps its comments.** `config/configs.jsonc` (was `.json`) is
  written by patching single values in place, so the annotated template survives every
  migration - previously each upgrade rewrote the document with `JSON.stringify` and deleted
  every explanation.
- **The config carries a schema `version` on its first line.** When the shipped template's
  version differs, CALL merges it in (your values win, missing keys and their comments are
  added), backs the old file up to `config/backup/` and reports what changed. Equal versions
  mean the file is not touched at all. `check-config.mjs` now fails when the template and
  `assets/check.jsonc` disagree, or when a key is undocumented.
- **Structure storage is per player and browsable**: `data/nbt/<player>/<name-or-id>/<id>.mcstructure`,
  the clipboard in `<player>/copy/<id>/`, undo/redo in `<player>/undo|redo/<id>/`, and
  hand-managed public structures in `data/nbt/public/<name>/`. Existing flat files are migrated
  on first start (originals kept in `data/nbt/_legacy/`, unattributable ones in `_orphan/`).
- **Public structures hot reload**: `data/nbt/public/` is rescanned when the menu opens (only
  directories whose mtime moved are re-read), so dropping a `.mcstructure` in makes it appear
  without a restart.
- **Selections and the clipboard survive a relog / restart**: `saveArea` and `saveCopy` now
  default to true (the old defaults wiped both in `CAPlayer.saveAll()` on logout). The area is
  re-drawn on join until `/ca area cancel`.

### Fixed

- `suvivalModeActive` was never validated by the schema; the check now also understands that a
  container key (`default`) is documented by its dotted children.
- The version parser rejected a prerelease suffix (`3.9.5-beta1` parsed as 0.0.0).

### Tests

- Unit 116: JSONC parser/patcher (comments preserved, nested paths, template rendering) and the
  store layout (illegal names, folder tree, slice naming, id index).
## [3.9.5] - 2026-11-07

### Fixed

- `/ca preview bartest` and `/ca preview bar` were asking `bossBarGetInfo` for ids that are not
  numbers, which the library answers with `参数类型不匹配（实际传入 variant#1）` in the console.
  Only the numeric candidate is queried now, so the diagnostic is quiet.

### Notes

- The library author confirmed the id exceeds the largest plain number; the id path stays as a
  probe (used automatically once the library returns something a JS number can hold) and the
  per-second rebuild keeps the countdown working meanwhile.
## [3.9.4] - 2026-11-07

The third live run showed the id is unusable, not just rounded:

```text
add -> 8070450532247928832(number, 已超出 2^53)
  8070450532247928832(bigint) -> setTitle=false info=?      ← 参数类型不匹配（variant#1）
  "8070450532247928832"(string) -> setTitle=false info=false  ← 同样不接受
  8070450532247928832(number) -> setTitle=false info=not_found
```

Only a **number** is accepted, and the number is a rounded view of a 64-bit id, so the low
bits are gone and the library can never find the bar again.

### Added

- **Boss bar rebuild mode**: when the id cannot be used, the countdown is reproduced by
  `bossBarRemoveAll` + `bossBarAdd` once per second (the title only changes once per second
  anyway). The bar counts down and disappears at the end without ever addressing an id.
  `previewBossBarRebuild` (default true) turns it off, which falls back to the action bar.
- `/ca preview bartest` now ends with a rebuild check, so one run proves the fallback works.
## [3.9.3] - 2026-11-07

Second live run confirmed the runtime hands over the bar id as a **Number**:

```text
add -> 8070450532247929000 (number)   ← the real value is 8070450532247928832
第1..6秒 update=false info=not_found
```

The double is a rounded view of a 64-bit id, and the library looks up the exact integer, so
every call after `add` missed. 3.9.3 reconstructs the exact integer from the double and probes
which encoding the library accepts (`bigint`, its decimal string, the raw number), keeping the
first one that answers true. If none does, the preview falls back to the action-bar countdown
immediately instead of leaving a dead bar on screen.

`/ca preview bartest` now prints one line per candidate, so a single run shows which form the
library accepts.
## [3.9.2] - 2026-11-07

`/ca preview bartest` on a live client showed the real failure:

```text
add -> 8070450532247929000
第1秒 update=false info=not_found   … 第6秒一样
remove -> false，剩余 1        (每次都多一条)
```

- **The bar id is a 64-bit value** (`0x7000000000000000` = 8070450532247928832). It was being
  converted with `Number()`, and the value handed back is what the library looks up - so every
  `setTitle` / `setHealth` / `setStyle` / `remove` missed, `getInfo` answered `not_found`,
  and each test run left another orphan bar on screen. The id is now passed through exactly as
  the runtime returned it (number, bigint or decimal string), never re-computed.
- `/ca preview bartest` prints the raw id **and its type**, so one run tells us whether the
  runtime gives us a lossless bigint or an already-rounded number.
- `/ca preview barclear` now also clears bars whose id can no longer be addressed
  (`bossBarRemoveAll`) and says when it had to fall back to that.
## [3.9.1] - 2026-11-07

The 3.9.0 countdown froze at the value it was created with and the bar survived the preview.

### Fixed

- **The countdown ticker ran on a bare `setInterval`**, unlike every other periodic task in
  the plugin: one throwing round killed it silently, which is exactly the frozen "20s".
  It now uses `Safe.every` (logged, never silently dead) and each player's update is wrapped
  separately so one failure cannot stop the others.
- **A dead bar is rebuilt instead of being trusted**: `setTitle`/`setHealth`/`setStyle` are
  checked, two failures in a row drop and recreate the bar, and every 2s the bar is compared
  against `bossBarGetInfo` - a bar whose anchor entity is gone keeps accepting calls while the
  client shows a frozen frame, and that is the only signal available.
- **`bossBarAdd` returns -1 on failure** per the library docs (ids start at 0); the old `> 0`
  test could orphan the very first bar of a session.
- **If the boss bar cannot be created or kept alive**, the preview switches itself to the
  action bar and says so once. While the action bar carries the countdown the selection hint
  yields that beat (`PreviewHudLock`), so the two never flicker over each other.
- Teardown removes the bar through a registry sweep as well as on cancel/timeout/logout, so a
  missed cancel cannot leave a bar behind.

### Changed

- `previewCountdown` now defaults to `always` (was `auto`, i.e. last 20 seconds only); existing
  `auto` values are migrated once with a console line.
- New `previewCountdownHud` (`auto` | `bar` | `actionbar`).

### Diagnostics

- `/ca preview bar` (state + library record + probe), `/ca preview bar test` (6 second self test
  printing every return value), `/ca preview bar clear`.
## [3.9.0] - 2026-11-06

### Added

- **Preview countdown.** A live preview now shows its remaining time on a **boss bar**
  (`bossBarAdd` / `bossBarSetTitle` / `bossBarSetHealth`, present in HologramLib 1.33.0 and
  1.35.0): the title counts down, the bar shrinks with it, it turns red at 10 seconds and warns
  at 5. A boss bar is used because the action bar already carries the selection hint every
  second - two writers on one channel would flicker. Without HologramLib the countdown falls
  back to the action bar and only appears in the last 20 seconds.
- `previewCountdown` (`auto` | `always` | `off`, default `auto`): `auto` shows the countdown
  only for the last 20 seconds, `always` keeps it up the whole time.
- **Sneak + left click with the preview wand cancels the preview** (mobile: sneak, then tap a
  block - touch tapping is the same `onStartDestroyBlock` event). The wand never breaks the
  block, and without a live preview the gesture only reports that there is nothing to cancel.
- `/ca preview info` reports the remaining seconds and which HUD carries them.

### Notes

- The preview wand lore and the shipped left-click binding now mention the cancel gesture.
- Each interaction (rotate / move / nudge) resets the countdown to the full timeout and makes
  it visible again immediately.

### Tests

- Unit 103: adds the gesture table (sneak decides confirm vs cancel), countdown text/style
  thresholds, and the action-bar fallback wording.
## [3.8.0] - 2026-11-06

Rotating and loading a 50k+ block build was slow. The library has no batch call, so the
work itself had to go: measured on the same 300k-cell selection, extraction drops from 624ms
to ~13-26ms, and a rotation no longer walks the whole build.

### Changed

- **Surface extraction is a bitmap** (`Uint8Array` occupancy + index arithmetic) instead of a
  `Map<string,string>` keyed by "x,y,z" that was re-split for every neighbour test. 624ms ->
  ~13-26ms for the same input; output is byte-for-byte identical (pinned by an equivalence
  test against a copy of the old algorithm over 60 randomised multi-slice cases).
- **The spatial index is clipboard-side**, so a rotation or a move no longer rebuilds it
  (26ms at 48k blocks, 65ms at 120k): only the window query runs again.
- **The send queue is replaced, not appended**: rapid rotations cost one plan instead of one
  per click, and cells are sent nearest-first.
- **Pumping is time-budgeted** (`previewTickBudgetMs`, default 8ms) instead of a fixed count,
  and `previewBatchSize` is now the per-round ceiling.
- `viewBlock` / `viewClearBlock` are bound once and called directly (no per-call lookup and
  argument spread).

Verified: 96 unit tests; test-live 36/36 on LL 26.51.8.
## [3.7.0] - 2026-11-06

Huge builds finally preview properly: the ghost streams the part of the clipboard around the
player instead of stopping at a hard cap.

### Added

- **Streaming preview with three automatic modes**:
  - `full` - surface blocks <= `previewMaxBlocks`: draw everything (unchanged);
  - `window` - more than that: draw only the cells within `previewRadius` (default 48) of the
    player, nearest first, and follow them as they walk (the window is recomputed when they
    move `previewUpdateDistance`, default 8);
  - `lazy` - the clipboard itself is bigger than `previewMaxCells` (default 800k cells): only
    the 64-block slices that intersect the window are parsed, LRU cached
    (`previewSliceCache`, never evicting a slice that is still on screen). Before this, such
    a selection simply reported "region too large" and drew nothing.
- **Look-direction prefetch** (`previewPrefetch`, default 16) and a **low-detail shell**
  (`previewOutline` / `previewOutlineStep`) so the whole shape still reads from a distance.
- `/ca preview refresh` and `/ca preview radius <16-192>`.

### Fixed

- **`assets/check.json` had 18 specs outside `configs`** (`areaDisplayMode` ...
  `chunkLoadTimeout`, `previewMaxBlocks` among them). Both the runtime check and
  `check:config` only read `check.configs`, so those keys were never validated - which is why
  `previewMaxBlocks: 800000000` loaded happily and was silently clamped at runtime instead of
  being reported. The specs are back under `configs`, and `check-config.mjs` now fails if any
  spec lands at the root again.
- **A bad value no longer disables the plugin**: `checkConfig()` clamps numbers into range and
  falls back to the template for unknown enum values, logging what it fixed, instead of
  throwing and refusing to load.

### Changed

- `previewMaxBlocks` is now the **on-screen budget** (default 12000, max 200000); the old
  "draw the top slice and drop the rest" truncation is gone. Old defaults 2000/8000 are
  migrated to 12000.

### Tests

- Unit 91: adds the streaming helpers (16x16 bucketing, window query with distance order and
  budget crop, prefetch, exact inverse transform for windows, outline sampling).
## [3.6.1] - 2026-11-06

### Fixed

- **Every fill step was reported as failed on LL 26.51** (`[FillService.fill] /fill ... ->
  commands.fill.success`): BDS 1.26.51 answers a completed `/fill` with `success: false` while
  printing the success message, and with no console language pack that message is the raw key
  (`commands.fill.success`). The code trusted the flag, so each 8-high slab was logged as an
  error and the whole operation reported failure even though the world was filled correctly.
  The message is now authoritative: `SafeArgs.isSuccessOutput()` recognises the translation key
  and the localised texts, and `run` / `runNow` treat such an output as success. This also
  covers `/clone`, `/setblock` and any other command whose flag disagrees with its message.
## [3.6.0] - 2026-11-06

The paste preview is drawn with **per-client block overrides** instead of one fake mob per
block. Smaller, static, and it finally lets a big building preview as a whole.

### Changed

- **Preview renderer: `viewBlock()` (HologramLib) instead of `itemDisplay*`.**
  `itemDisplay*` works by spawning a fake MOB that holds the block (the library's own
  `itemDisplayEmitForEntity` spells out `AddActor(fox) + MobEquipment`), so every ghost block
  inherited the mob's idle animation - the "假方块随风飘扬" report - and each one was a full
  client entity, which is what collapsed the frame rate and made a large preview load only
  partially. `viewBlock(player, x, y, z, id)` only tells ONE client "show that block at that
  cell": no entity, no animation, correct model/lighting, and the cost is a block update.
  There is deliberately **no entity fallback** any more.
- **Only the difference is re-sent.** The scene tracks which cells it has applied, so rotate
  and move send just the changed cells, and four quarter turns end with zero packets.
- **Teardown clears exactly its own cells** (`viewClearBlock`), never `viewClearAll`, which
  would also drop overrides another plugin registered for the same player. Clearing is batched
  over ticks, and cells belonging to a player who left are retried when they rejoin (the
  library keeps overrides by player name).
- **`previewMaxBlocks` 2000 → 8000** (max 50000) and **`previewBatchSize` 200 → 1000**
  (max 5000). The old numbers were sized for one entity per cell; they are the reason a large
  preview looked truncated. An untouched old default is migrated automatically, and the console
  says so.

### Notes

- `previewBlockScale` / `previewBlockOffsetY` / `previewBlockYCorrection` no longer affect the
  ghost (a block override IS the block); they are still used by `/ca preview probe`, `trim`
  and `calib`, which measure the item-display pose for their own debugging value.
- A block override carries the block **id**, not its states - stairs still preview with the
  default facing, exactly like the paste, which does not rotate states either.

### Tests

- Unit 84: adds the preview planner (cell mapping, diff-only rebuilds, four quarter turns =
  zero packets, cleanup cell list).
## [3.5.2] - 2026-11-06

### Fixed

- **The bundled tool items did not exist on 1.26.51** ("内置工具物品尚未生效"): the item
  definitions were authored with `format_version 1.26.60`, and an engine upgrades OLD
  documents but silently **discards** documents newer than it handles - BDS 1.26.51 logs
  `[Json] upgrade items/gear.json | document's version is out of handled range` and every
  `call:*` item disappears, pack loaded and all. The six item files now use `1.21.40`, which
  1.26.51 and 1.26.60 both accept (verified on LL 26.51.8 / LSE 0.22.3 and 26.60.1 / 0.23.1).
  No pack-version bump on purpose: the manifest identity does not change, so the new files
  are picked up on the next start instead of costing two restarts and a "pack not found"
  warning in between.
- **A false "restart the server" warning**: the item probe ran during the plugin enable pass,
  before the world had necessarily loaded its packs. It is now re-checked once the server has
  started, and the message explains the real causes (content log / format version) instead of
  blaming a missing restart.
- **LSE 0.22.3 was rejected by the compatibility warning** even though it works: the minimum is
  now 0.22.0 (verified on 0.22.3). The Node.js engine is not sensitive to these patch releases.

### Changed

- `/ca tools status` prints the whole picture: config switch, last install result, whether the
  engine registered the items, the pack version and `texturepack-required`.
## [3.5.1] - 2026-11-06

### Fixed

- **A newly shipped tool item did nothing when clicked, with no error** (the adjust wand in
  3.5.0). Its bindings were never delivered to an existing install: `healMissingKeys()` only
  fills *top-level* config keys, and `mergeToolBindings()` can only copy an entry that
  `configs.json -> default.items` already contains - which is written once and never grows.
  Clicking then fell through `matchBinding()` and returned silently.
  Now:
  - `Config.toolBindingDefaults()` merges the **shipped template** with the server's own
    `default.items` (customisations win, the template fills what it does not know), so every
    bundled tool always has a source;
  - the settings migration reads that merged set;
  - `ToolOperation.onClick()` merges on the spot for a bundled tool with no binding, so the
    wand works on the next click without a reconnect, and if it still cannot resolve it tells
    the player instead of doing nothing;
  - startup writes the missing bundled bindings back into `configs.json`;
  - `/ca tools give` reports when fewer items than expected could be created.
## [3.5.0] - 2026-11-06

Preview content that finally matches the paste, a selectable rotation pivot, and one
adjustment wand instead of six directional tools.

### Fixed

- **The preview showed the clipboard transposed** ("最终粘贴还是和预览不一致"):
  `SurfaceExtract` decoded `block_indices` with `i = z*sx*sy + y*sx + x` (X fastest), while
  the format is ZYX (`SZ*SY*X + SZ*Y + Z`, see `StructureOrder`). A 3x1x3 clipboard of
  horizontal stripes previewed as vertical stripes while the paste - which goes through
  `cellCoords()` - wrote the correct ones, so it looked like the ghost had been rotated
  towards the player. The preview now uses `cellCoords()` too. Every preview fixture used to
  be a solid cube, where any axis permutation is invisible; the tests now label each cell.
- **New tool items could never appear**: `enablePack()` returned `changed: false` whenever
  our uuid was already in the world pack list, so a bumped pack version was never written and
  BDS kept loading the old copy. It now compares the version and rewrites the entry.

### Added

- **Rotation pivot** `previewPivot`:
  - `inplace` (default) - the box stays on the anchor and only its contents turn;
  - `anchor` - the clicked cell is the vertical axis, so the box swings into the neighbouring
    quadrant (offsets may go negative). This is the behaviour CALL had before the box was
    normalised, and what is described as "绕轴旋转".
  `/ca preview pivot [inplace|anchor]`, or left-click the adjust wand. Preview, wireframe,
  undo snapshot and paste all read the same offset, so they cannot drift apart.
- **Position nudge** `/ca preview nudge <dx> <dy> <dz>` (no arguments clears it). The offset
  moves the ghost AND the paste - re-anchoring resets it.
- **Adjust wand** `call:wand_adjust` (bundled item pack 1.1.0):

  | click | effect |
  |---|---|
  | right-click a block face | nudge one block along that face's normal (top = up) |
  | sneak + right-click | nudge the opposite way |
  | left-click | switch the rotation pivot |

  The clicked face reaches the command layer through `caPlayer.lastClickSide`, because a bound
  command only receives coordinates.

### Tests

- Unit 75: adds the transpose regression (unique block per cell, 3x1x3/2x3x2/3x1x5, plus the
  real striped clipboard) and runs the preview-vs-paste matrix over both pivots.

## [3.4.0] - 2026-11-06

Bundled tool items, a server-side selection wireframe, and a real fake-block paste preview.

### Added

- **Tool items** (own `call:` namespace addon, no vanilla id reused): gear, selection wand,
  copy wand, paste wand, preview wand. Creative-only, no recipe, cannot break or place blocks.
- **Selection wireframe** (`areaDisplayMode: wireframe`, the new default): a box outline every
  player sees, drawn client-side by HologramLib, no world writes.
- **Real fake-block paste preview** (`previewMode: ghost`): the actual blocks are drawn on the
  client through `itemDisplay`, so you see what will be pasted before confirming. Surface
  culling, a block budget, per-tick batching, view distance and per-player visibility keep it
  cheap; teardown only ever destroys our own display ids.
- `/ca preview set|click|move|rotate|mirror|confirm|cancel|mode|probe|calib|info`.
- `/ca tools [give|list|status|pack|debug]`.

### How the preview is aligned (and why it took a few rounds)

- Block mode applies **two** transforms; the second one (`itemDisplaySetExtend`) defaults to
  `rx=-90`, which flung every block several blocks away from its anchor. It is now pinned to
  `extend(1, 0, 0)`.
- The display's model hangs half a block below its anchor: measured with `/ca preview probe`
  (a 5-cell wireframe ruler plus one grass block) and applied as
  `previewBlockYCorrection = 0.5` **in blocks** - a unit that can be read off the ruler, instead
  of guessing model-unit offsets.
- Previews are created with `itemDisplayCreateSeamless` so mode/view distance/visibility are
  set in the same packet (creating first and changing the mode respawns the display).
- **Rotation is anchored at the minimum corner of the paste box** (= the block you clicked).
  The rotated box grows from the anchor instead of reaching into negative offsets, so turning
  a clipboard never slides it sideways. The preview, the outline, the undo snapshot and the
  paste itself all use one mapping - `transformCell()` in `Rotate.ts`, whose rotation table is
  a verbatim copy of `NbtCodec.transformLayout()`, the function that actually writes blocks.
- Preview blocks are **not model-rotated** any more (`rotY = 0`). `transformLayout` only moves
  cells, it does not turn block states, so a rotated model showed a facing the paste was never
  going to write.

### Fixed

- **Rotated paste landed (edge - 1) blocks away from the preview**, e.g. 3x1x3 turned 90° pasted
  at x+2..x+4 while the ghost sat at x-2..x. `StructureService.load()` transformed the slice
  areas with `Transform3` and then shifted them by `tx/tz` to undo the negative half of the
  rotation - but `transformLayout` already normalises the result, so the rotation was applied
  twice. `load()` now only decides each slice's minimum corner (`sliceDestMin`).
- **The preview wireframe and the undo snapshot were computed from the clipboard's absolute
  coordinates** instead of clipboard-relative ones: a clipboard copied 1200 blocks away drew its
  box (and took its undo snapshot) thousands of blocks off, with Y counted twice. `rotatedUnion`
  / `rotatedTargetAreas` now work off `clipboardBox()` (minimum + extent).
- **Multi-slice paste**: slices of a rotated clipboard were placed with the whole-box shift
  applied to each slice's start corner, which does not survive a mirror or a quarter turn. The
  destination is now the minimum of the slice's two transformed corners, verified against
  whole-box rotation for 64/65/100/130-block footprints.
- **`/ca load ... <mirror> <degrees>`**: the undo snapshot was the unrotated source box moved
  onto the target, so `/ca undo` restored a different region than the load wrote.
- **Preview and paste disagreed on multi-slice clipboards**: the ghost used the clipboard
  minimum as its origin while the paste used the absolute slice areas; both go through the same
  relative mapping now.

- **Preview could not read a clipboard at all** (`load.missingFile`): entries are keyed by
  structid, the files are `<structid>_<ix>_<iz>` from `Structure.getAreas()`. The preview now
  follows `StructureService.load()` exactly.
- **Clicking a tool did nothing**: per-player settings are a snapshot taken at registration, so
  older players had no `call:*` bindings; they are merged in on login (only for our ids, only
  when missing). Bindings are also keyed by the item's display name, so the lookup now falls
  back to the empty-name entry.
- **Tool icons rendered blank**: the item JSON had `menu_category.group` without a namespace, so
  BDS refused to parse all five items (found via the content log).
- **Multi-slice paste stacked every slice on the same anchor**: `load()` zeroed each slice's
  origin with `Area3.relative()`; the clipboard minimum is subtracted instead.
- **Config upgrades disabled the plugin**: `checkConfig()` throws on keys declared in check.json
  but missing from configs.json. Missing keys are now filled in from the template on startup.
- `Paths.SERVER_ROOT` detection for LL 26.60, where `plugins` is a junction to `mods` and the
  script engine reports the real `mods/<plugin>` path (CALL used to create a stray
  `D:\structures` folder).

### Tests

- Unit 72: layout migration, preview rotation maths, **preview vs paste geometry** (7 clipboard
  shapes x 4 angles x 4 mirrors, multi-slice tiling, undo-box coverage), surface culling, chunk
  splitting, binding lookup/migration, block-unit correction.
- Verified on BDS 1.26.60.6 / LSE nodejs 0.23.1 / HologramLib 26.60.1.

## [3.2.0] - 2026-11-06

### Added - bundled tool items

CALL now ships its own addon (`assets/addon/CALL_Tools_BP` + `CALL_Tools_RP`) that defines
five items under the `call:` namespace, so no vanilla item id is reused and nothing can
collide with another plugin:

| item | left click | right click |
|---|---|---|
| `call:gear` | - | open the menu |
| `call:wand_select` | point A | point B |
| `call:wand_copy` | - | copy the selection |
| `call:wand_paste` | - | paste at the clicked block |
| `call:wand_preview` | move anchor | set anchor / rotate 90 degrees (sneak = confirm) |

- Items are creative-only (`/ca tools` hands them out), have no recipe, and cannot break or
  place blocks: `can_destroy_in_creative: false` plus an `onDestroyBlock` cancel, because
  LSE's `onStartDestroyBlock` cannot be cancelled.
- The packs are installed automatically into `behavior_packs` / `resource_packs` and enabled
  by merging (never overwriting) the world pack lists. Enabling needs one restart, and the
  console says so instead of pretending the items exist.
- `/ca tools`, `/ca tools list`, `/ca tools status`.

### Added - HologramLib wireframe + paste preview

- `areaDisplayMode` gains `wireframe` and it is the new default: a server-side box outline
  that every player sees, drawn without touching the world (DebugShape packets).
  Without HologramLib it falls back to the particle outline.
- New `/ca preview ...` (also driven by the preview wand): shows the ROTATED destination box,
  rotates/mirrors it, then pastes exactly what was previewed. The undo snapshot uses the
  rotated footprint, not the original one.
- Why there is no fake-block preview: HologramLib exposes no client block override, and
  `UpdateBlockPacket` needs network block runtime ids that LSE does not expose. Guessing them
  crashes clients. Documented in `docs/user/tools.md`.

### Changed

- `Paths.SERVER_ROOT` detection now walks up to the server executable and understands the
  LL 26.60 layout, where `plugins` is a junction to `mods` and the script engine reports the
  real `mods/<plugin>` path. Before this fix CALL created a stray `D:\structures` folder.
- Shape packs are loaded by absolute path (`Config.SHAPES_PATH`); the old code needed the
  plugin to sit exactly two levels below the server root.

### Tests

- Unit 46 (was 40): adds `preview-rotate.test.mjs` covering rotation/mirror maths and the
  rotated destination areas.
- Verified on BDS 1.26.60.6 / LL 26.51-compatible 26.60 line / LSE nodejs 0.23.1 with
  HologramLib 26.60.1: `HologramLib 1.35.0 - wireframe ready` (a real shape create+destroy
  round trip) and `tool items ready` (the addon items resolve).

## [3.1.0] - 2026-11-05

### Changed - release layout

The package used to nest everything under `userdata/` while the plugin root mixed
read-only resources with user files, which made the (already mis-documented) config file
impossible to find. The layout is now three clearly separated areas:

~~~text
plugins/CALL/
  core/            program
  assets/          read-only: lang/, bin/CALL-CLI.exe, check.json, configs.default.json, ...
  config/          YOUR configuration: configs.json, userlist.json, permission.json
  data/            YOUR data: nbt/, shapes/, import/, export/, settings.json, structures.json
  node_modules/    installed by LSE on first start
~~~

- **Existing installs migrate automatically** on first start, before any file is opened
  (`core/src/common/Layout.ts`). A target that already exists is never overwritten - the
  legacy file is kept as `*.old` - and a failure leaves the old files untouched.
- Renamed `userdata/config/stupid_permission_file.json` to `config/permission.json`.
- Shape packs moved from `userdata/plugins/` to `data/shapes/`.
- **Deleted directories and files that were never used**: `userdata/temp/`,
  `userdata/build/` (always empty), `config/update.json`, `config/url.json`
  (`Config.UPDATE` / `Config.URL` had no readers - auto-update was removed in 2.0).

### Changed - dependencies are no longer shipped

`node_modules/` is **no longer packaged** (it was 2.11 MB, 63% of the unpacked size).
Verified on LL 26.51.x: when the folder is missing, LegacyScriptEngine runs
`npm install --omit=dev` for the plugin and the plugin loads normally.

- Default artifact `CALL-<version>.zip` is now **0.42 MB** (was 0.96 MB).
- Offline servers get `CALL-<version>-full.zip` with the dependency tree vendored.
- Documented in the install page, including what to do without npm access.

### Fixed

- `io/Utils.ts` built the CLI path from `process.cwd()`, so the import/export helper was
  not found when the server was started from another working directory. It now uses the
  plugin-relative `assets/bin/CALL-CLI.exe`.
- `PermissionOperation.findByFile` threw when `permission.json` was missing or malformed;
  it now treats that as "not in the whitelist".
- The startup log prints `[CALL] config: ...` **and** `[CALL] data: ...`, plus a warning
  when a legacy layout was migrated.

### Tests

- Unit: 40 (was 33). Adds `tests/unit/layout-migration.test.mjs` - the planner mapping,
  the "never overwrite" rule, pruning of the legacy tree and "user files in temp/ are
  left alone".
- Live: 37 (was 34). Adds `layout.freshInstall` (the old paths must be gone, the new ones
  present) and `layout.dependenciesInstalled`.
## [3.0.8] - 2026-11-04

### Fixed

**Any block carrying states (stairs, slabs, logs, fences...) could not be pasted or restored.**

`NbtCodec` parsed palette states into plain JS numbers/strings and `StructurePlacement` fed
those straight into `new NbtCompound({...})`. LSE only accepts **NbtTag instances** there, so
every such placement threw

~~~text
Wrong Type of data to set into NBT Compound!
   at blockNbtOf -> placeLayoutAsync -> NBTService.loadAsync -> traversal
~~~

and took the whole slice down with it: paste, load and undo of anything containing a stateful
block did nothing at all.

- The parsed layout now keeps each state's original NBT tag id (`NbtTypedValue`), and the
  writer rebuilds `NbtByte` / `NbtShort` / `NbtInt` / `NbtLong` / `NbtFloat` / `NbtDouble` /
  `NbtString` accordingly.
- A state that cannot be rebuilt is dropped **on its own** (logged once) instead of aborting
  the placement; the block type is still written correctly.

**`/ca fill <block> [...states]` rejected every syntax except one.**

`States` is a single String command argument, so `["a"=1,"b"=2]` was split at its spaces,
arrived truncated and failed the bracket check - producing `invalid:minecraft:smooth_stone_slab`,
which reads like a bad block name. Now:

- `normaliseBlockStates()` accepts `["a"=1]`, `[a=1]`, `a=1,b=2`, `{"a":1}` and the
  `block[state=value]` token form, always emitting the canonical syntax;
- the token form (`minecraft:oak_stairs[weirdo_direction=2]`) contains no spaces, so the
  command parser can never split it - it is now the documented, recommended spelling;
- states that are supplied but unusable are still **rejected** rather than silently dropped,
  so a fill never places a different variant than requested;
- the failure log now includes the offending **states string**, not just the block name.

### Tests

- Live (`npm run test:live`): 34 assertions (was 31).
  - `ca.fillWithStates` - the four accepted spellings, each verified by reading the block's
    states back;
  - `ca.pasteStateful` - stairs + log saved and pasted, states compared exactly;
  - `ca.undoStateful` - clear then undo, states restored exactly.
  State **names** are discovered at runtime (1.26 calls the stairs direction
  `weirdo_direction`), so the tests do not depend on a specific game version.
- Unit (`npm run test:unit`): 33 (was 26). Adds `tests/unit/block-states.test.mjs`.

> Why this survived seven releases: every previous test used stateless blocks (stone, gold,
> diamond, iron, emerald, lapis). The suite now always includes stateful ones.
## [3.0.7] - 2026-11-04

### Documentation site

**https://owoser.github.io/CALL/** is now the official documentation, published from
`docs/` with GitHub Pages (the same docsify setup the upstream project used).

- **Rebranded** for this fork: LL3 / LSE versions, the real GitHub URLs, current version and
  licence, no more links to the upstream repository or its (1.x) docs site.
- **Dependencies vendored**: docsify, the theme and all four plugins are now served from
  `docs/vendor/` instead of jsdelivr/unpkg. A blocked CDN used to leave the whole site
  blank; jsdelivr is unreachable from mainland China, so this is not a theoretical concern.
- **Search enabled** (docsify search plugin) and `notFoundPage` turned on.

### Documentation corrected

- **`user/config.md` rewritten.** It repeated the upstream mistake of
  `CALL/config/configs.json`; the real path is
  `plugins/CALL/userdata/config/configs.json` (verified against upstream 1.6.1's own
  `USER_CONFIG_PATH`). It now documents all 22 keys with defaults, ranges and which
  version added them, plus the three keys that still ship but are **no longer read**
  (`autoUpdate`, `updateFrom`, `maxLoadCheckNum`).
- **`user/install.md` rewritten** for LL3 + LSE (was LiteLoaderBDS + minebbs), including
  the "folder name must equal manifest name" requirement and how to confirm the plugin
  loaded.
- **`user/introduction.md`**, **`other/update.md`**, **`other/debug.md`** rewritten:
  no auto-update, no QQ group, correct command names and paths.
- **`other/question.md`**: removed the auto-update answer, fixed the import/export paths,
  added a 3.x FAQ (large regions, "outside the loaded chunks", partial undo, block entities).
- **`user/function/console.md`**: `call update` replaced by `call reload`.
- **`dev/plugin.md`**: shape packs live in `plugins/CALL/userdata/plugins`, not
  `CALL/plugins/shape`.

### Added

- `docs/user/migrate.md` - upgrading from 1.x / 2.0 (data is compatible, behaviour is not).
- `docs/other/limitations.md` - block entity contents, waterlogged blocks, size caps,
  ticking-area limits.
- `docs/dev/architecture.md` - the platform traps (banned `mc.setStructure`, the ZYX index
  order, the boss-bar enum, chunk leases, why `/structure load` cannot be used).
- **`npm run check:docs`** - fails when a sidebar/navbar link is dead, when a page links to
  the upstream project again, or when a config key is undocumented. Wired into CI.
- **`.github/workflows/ci.yml`** replaces the inherited 1.x workflow (which called a
  `gulp` build that no longer exists): typecheck, config schema, docs, build, unit tests.

## [3.0.6] - 2026-11-04

### Fixed

**Undo of a large region failed with "structure too large to place block by block".**

Restoring wrote blocks one at a time under `maxPlaceBlocks` (40000), a guard meant for shape
generation. A 107x99x90 undo is four slices of up to 368640 cells, so every slice was
refused and nothing came back.

- New `maxRestoreBlocks` (default **2000000**) applies to the restore paths - undo, redo,
  paste, load. `maxPlaceBlocks` keeps guarding generated shapes.

**A failed undo deleted the snapshot.**

`StructureService.pop` popped the entry first and then deleted each slice file
*unconditionally* after `load()` returned - and `load()` swallows slice failures. So a failed
undo destroyed exactly the data needed to retry it. Now:

- `traversal` reports the number of failed slices to its completion callback, and
  `StructureService.load` returns it;
- `pop` peeks instead of popping, restores, and only consumes the entry and deletes the
  files when **every** slice succeeded. On failure it keeps everything and tells the player
  the undo was incomplete and can be retried.

**Restores are much faster.**

- Cells that already match the target are skipped (one `mc.getBlock` compare instead of a
  write). Undoing a clear is almost all air that is already air. Blocks carrying states are
  never skipped, because the name can match while the variant does not.
- `placeBatchBlocks` default 600 -> **2000**.
- A long restore now shows throttled percentage progress instead of going silent.

### Verified and rejected: the native paths

| Option | Result |
|---|---|
| `mc.setStructure` | access violation 0xC0000005 - still banned |
| `/structure load` + our file in `<bds>/structures/` | "找不到 mystructure:callprobe" |
| `/structure load` + `structures/mystructure/` subdir | same |
| world structure store | lives inside the world LevelDB; only `/structure save` can seed it |

So per-block writing stays, made survivable rather than avoided.

### Tests

- Live (`npm run test:live`): 28 assertions. `ca.undoLarge` seeds a **96x16x96** region
  (largest slice 64x16x64 = 65536 > 40000), clears it, verifies that a deliberately
  impossible undo keeps both the list entry and the files, then verifies the real undo
  restores every sampled cell and consumes exactly one entry.
- Unit (`npm run test:unit`): 26. Adds `tests/unit/restore-skip.test.mjs`.

## [3.0.5] - 2026-11-04

### Fixed

**An operation could silently never start.**

`StructureService.save` signals slice failures by throwing after its traversal loop, and
`undoPush` handled that with `catch(e => logger.error(...))` - the error was logged and the
completion callback was **never invoked**. So for any operation that snapshots first (fill,
clear, hollow, outline, replace, paste, move, rotate, mirror, shapes) a failed snapshot made
the whole thing vanish: nothing ran, and the player was told nothing.

- `undoSave`/`undoPush` take a failure callback, and every caller now has one.
- Fill/clear/hollow/outline **proceed without the snapshot** and warn the player that the
  operation cannot be undone. Doing nothing at all is strictly worse.

**The undo snapshot had no retry.**

It calls `mc.getStructure`, which - like `/fill` - returns nothing until the chunk is ready,
so a large selection could fail its snapshot on the same race the fill had. Each slice is
now captured with three attempts, 700ms apart, and reports which slice was lost.

### Tests

- Live (`npm run test:live`): 27 assertions, green on consecutive runs.
  `ca.clearLargeRegion` now waits for the operation's own completion callback instead of
  polling ticking areas: there is a gap between slices where no lease is held, which made
  the test declare "finished" while the fill was still running, and report a false failure.

## [3.0.4] - 2026-11-04

### Fixed

**Intermittent failure on large regions: "the area is outside the loaded chunks".**

3.0.3 took a ticking-area lease and polled `mc.getBlock` until the region read back. That
poll is worthless: **`mc.getBlock` force-loads a chunk on demand**, so the very first probe
returns a block and `waitLoaded()` is instantly true - the ticking area had not been
registered yet, and `/fill` raced it. A 96x96 clear therefore passed or failed depending on
timing (measured: pass, then fail on the last slice, log line
`step:(416,140,480)->(479,147,511):140:not-loaded`).

Two changes:

1. `Chunks.acquire` now waits a settle period proportional to the region
   (`200ms + chunks * 60ms`, capped at 1.5s) after adding the ticking area, instead of
   trusting the probe.
2. `FillService` **retries** a command whose result classifies as "not loaded" (four
   attempts, 800ms apart) before reporting it. The classifier already distinguishes that
   case, so this needs no new detection logic.

Because there is no reliable way to observe chunk-load state from the script API, the retry
is the actual guarantee; the settle period just avoids doing it in the common case.

### Tests

- Live (`npm run test:live`): 27 assertions, including `ca.clearLargeRegion`
  (96x8x96 = 6x6 chunks, 400 blocks away from the player) which reproduces exactly this
  flake. Confirmed green on consecutive runs.

## [3.0.3] - 2026-11-04

### Fixed

**Large selections failed with "无法在世界外放置方块" / "Cannot place blocks outside of the world".**

That is BDS' message for **unloaded chunks**, not for a size problem. Verified on a live
server with no player nearby:

| Command | Result |
|---|---|
| `fill 0 120 0 63 127 63 minecraft:stone` | fails - "cannot place blocks outside of the world" |
| `tickingarea add 0 120 0 63 127 63 callprobe` | ok |
| `fill 0 120 0 63 127 63 minecraft:stone` | ok - 32656 blocks filled |

1. **The ticking area was released before the work started.**
   `Chunks.ensureLoaded` removed its ticking area in a `finally` block, i.e. **before** the
   caller ran `/fill`. Small selections worked only because the player was standing in
   those chunks anyway. Replaced with a reference-counted **lease**:
   `Chunks.acquire(area)` → `lease.release()`, held by `StructureService.traversal` for the
   whole slice, so the undo capture (`mc.getStructure`) and the fill both run inside it.

2. **`acquire()` returned without waiting for the chunks.**
   The create path issued `tickingarea add` (deferred!) and returned immediately. It now
   adds synchronously and waits until the region reads back.

3. **"readable" does not mean "/fill accepts it".**
   `mc.getBlock` loads a chunk on demand, so `isLoaded()` returned true for regions the
   command layer still refused. `acquire` therefore always takes a ticking area instead of
   trusting that check.

4. **`isLoaded()` sampled a 5x5 grid, which skipped chunk columns.**
   A 96-wide region was sampled at x = 0, 24, 48, 71, 95 - chunk columns 0,1,3,4,5, so
   column 2 was never checked. It now probes every chunk column covered by the area.

5. **One failing slice aborted the entire operation - silently.**
   `traversal` did `return` on the first failure, so every later slice was skipped *and*
   `overCallback` never ran: a 96x96 clear could process one slice, leave the rest untouched
   and report nothing at all. It now continues, records the failure and always reports.

6. **Failure reporting.** One aggregated message per operation instead of one identical
   toast per slab (the reported screenshot had fourteen). A not-loaded failure is now shown
   as "the area is outside the loaded chunks" with an actionable hint, and every failing
   slab is logged with its coordinates.

**Slab sizing.** The fixed height of 8 made a full 64x64 slice exactly **32768** blocks -
the `/fill` ceiling, with zero margin. Slab height is now derived from the slice footprint
(`SafeArgs.slabHeight`, target 30000), so it is 7 for a full slice and still 8 for small
ones.

**`chunkLoadTimeout`** defaults to 15000ms (was 4000) with a 15000ms floor and a 60000ms
configurable maximum: generating a 6x6 chunk region at distance takes seconds.

**Ticking area hygiene.** BDS allows only 10 ticking areas: leases are reference counted
per region, at most one is held at a time, release is idempotent, `ll.onUnload` releases
everything, and startup sweeps any `call_*` area a killed process left behind.

### Tests

- Live (`npm run test:live`): 27 assertions.
  - `chunks.lease` - a lease really creates a listed ticking area, the region reads back,
    and releasing (twice) removes it.
  - `ca.clearLargeRegion` - a **96x8x96 (6x6 chunks)** region 400 blocks away from the
    player is seeded, cleared through the real `FillOperation.clear` path, and verified
    empty at three points; CALL must create its own lease and release it (no leak).
- Unit (`npm run test:unit`): 22. Adds `tests/unit/fill-sizing.test.mjs`
  (slab heights stay under the command limit, and BDS message classification).

## [3.0.2] - 2026-11-04

### Fixed

**`/ca clear` did nothing and reported "invalid block or region: air".**
`FillOperation.clear` builds `new BlockType("air")`, and the validator added in 3.0.0
required a `namespace:path` form, so the bare name was rejected before it reached the
command parser. The command parser itself accepts bare names and assumes `minecraft:`.
Bare names are now normalised (in `BlockType`, in `SafeArgs.normaliseBlockName` and in
`Cmd.blockArg`), which also un-breaks third-party shape packs that use `stone` etc.

**The operation reported success even when every slab failed.**
`FillService.ergod` counted failures but never told the caller, so `/ca clear` printed
"已清空区域" after doing nothing. `ergod`/`soildFill`/`fillOutside` now return
`(ok, warn)` and `FillOperation` prints the success message only when the fill actually ran;
otherwise it reports the failure count.

**`fillCommand` could emit a stray replace block.**
The empty `BlockType` used as a "no second block" sentinel is now kept empty (it must not
be normalised to `minecraft:air`) and `fillCommand` only appends a replace filter when one
was really supplied - otherwise the command became
`/fill ... minecraft:stone minecraft:air`, which is invalid.

**Validator hardening** (found while writing the tests for the above):

- `normaliseBlockName` rejected nothing for names like `../evil` (now: namespace and path
  are dot-separated `[a-z0-9_-]` segments, so `..`, stray slashes and extra colons fail);
- `isBlockStates("[]")` returned true; an empty states list now reports "no states" so it
  is never emitted.

### Tests

- Unit (offline, `npm run test:unit`): 19 tests. Adds `tests/unit/safe-args.test.mjs`
  (bare-name normalisation, rejection of malformed names, block-state syntax, clamping of
  boss-bar colour/percent, message type, dimension and Y).
- Live (`npm run test:live`): 25 assertions. Adds `ca.clearRegion`, which runs
  `/ca clear` through `FillOperation` on a 4x3x4 stone block and asserts every cell becomes
  air.

## [3.0.1] - 2026-11-04

### Fixed

**Pasted structures came out transposed.**
`block_indices` is stored in **ZYX order** — `SZ*SY*X + SZ*Y + Z`, i.e. Z varies fastest
(Bedrock .mcstructure spec, tryashtar / wiki.bedrock.dev). CALL used "Y varies fastest",
so a wall standing in the XY plane was written flat into the XZ plane and a flat selection
became a tall box. The index math now lives in one place,
`core/src/io/StructureOrder.ts`, and is used by both the per-block writer and the
mirror/rotation transform.

**Why the 3.0.0 tests did not catch it** (worth recording):
the only copy/paste case used a **4x2x4** region, so `sx === sz` and the X/Z swap was
geometrically invisible; the two marker blocks sat on the first and last index, which map
to themselves under *any* axis permutation; everything else was the same material.
The suite now covers a 3x2x1 and a 1x2x3 region with six distinct materials, cell for cell.

**Air in a snapshot did not clear the destination.**
The writer skipped air and `-1` alike. Per the spec they mean different things: `-1` is
"no block here, leave the world alone", while a palette entry for `minecraft:air` is a real
block that must be written. Placement now takes `writeAir`:
true for paste / load / undo (the result has to match the snapshot exactly), false for
generated shapes (a shape pack uses air for "do not generate", so writing it would carve
holes in the terrain).

**`/ca shape load` teleported the player somewhere unrelated.**
`CAPlayer.prePos` was a latched field owned by whichever operation had last called
`savePos()`, and `traversal()` restored it unconditionally in its `finally`. Shape
generation never called `savePos()`, so it reused the **previous** operation's position.
Since chunk loading no longer moves the player (`/tickingarea`), every teleport was removed
outright: `savePos`/`tp`, `prePos`/`direction`, and all 22 call sites.

### Tests

- Unit (offline, `npm run test:unit`): 14 tests. Pins the ZYX order explicitly, checks
  that a Y-fastest layout would fail, and covers index/coords round trips, 90/180/270,
  x/z/xz mirrors and idempotence.
- Live (`npm run test:live`): 24 assertions. Adds asymmetric round trips (3x2x1 and
  1x2x3, six distinct materials), air semantics, and "the operation must not move the
  player" on both fill and paste.

### Known limitations (unchanged)

- Block entity data (`block_position_data`) is not restored: chests/signs keep their
  position but lose their contents.
- Only the primary block layer is written, so waterlogged blocks come back dry.

## [3.0.0] - 2026-11-04

### The three bugs that made CALL unusable on LL3

**1. `/ca fill` disconnected the player (server stayed up).**
`FillService` passed boss-bar colour **11** to `Player.setBossBar`. LSE casts that number
straight into BDS' `BossBarColor`, which is `enum class : uchar` with only **0..7**, and
sends it in a `BossEventPacket` - the client received an out-of-range colour and dropped
the connection. Copy/paste passed 1 and 6, which is exactly why only fill was affected.
Every `setBossBar` call also emitted a fake `AddActorPacket(mActorType="player")`.
*Fixed*: `setBossBar`/`removeBossBar` are gone; progress is throttled text, and
`core/src/game/SafeArgs.ts` clamps every client-visible value.

**2. Paste failed with "structure has no usable size".**
`NbtCodec.detectEndian` guessed the byte order from a length check. For a little-endian
file that check reads the constant **782**, so every `.mcstructure` **larger than 787
bytes** was misclassified as big-endian and refused to parse. Small test regions (3x2x3 =
337 bytes) happened to stay under the threshold.
*Fixed*: both byte orders are parsed and the winning parse must consume the buffer
exactly. Regression test runs against four real game structure files (2.6 KB - 23.7 KB).

**3. Pasted/generated structures were written block by block, ignoring rotation.**
Follow-up to the 2.0 finding that `mc.setStructure` crashes the server: mirror and
rotation are now applied in `transformLayout` before the blocks are written, so
`/ca rote`, `/ca mirror`, `/ca paste ... 90_degrees` and `/ca load` no longer silently
paste an unrotated copy (`/ca move` cleared the source first, so that was data loss).

### Added

- `core/src/game/Cmd.ts` - the single command execution layer:
  `run`/`runNow`/`runAs`/`runAt` plus validated builders (`fillCommand`,
  `cloneCommand`, `structureCommand`, `teleportCommand`). Commands are deferred a tick
  so the dispatcher is never re-entered, and failures are returned instead of swallowed.
- `core/src/game/SafeArgs.ts` - clamping/validation for everything client-visible.
- `core/src/game/Chunks.ts` - `/tickingarea` based chunk loading with guaranteed cleanup
  and a startup sweep.
- `tests/unit/` - offline tests for the NBT codec and for mirror/rotation
  (`npm run test:unit`, no server required).
- `tests/live/` now drives the **real fill path** (`FillOperation` → `FillService` →
  traversal → `/fill`), the selection highlight, rotation on load, and copy → paste:
  21 assertions.
- `docs/ARCHITECTURE.md` - platform behaviour, banned APIs and why.
- New config keys: `chunkLoader` (`tickingarea`|`none`), `chunkLoadTimeout`.

### Changed

- **`areaDisplayMode` defaults to `structure_block`** (the particle outline added in 2.0
  turned out not to render on this platform). The highlight now only ever occupies a
  verified air block, is journaled to `userdata/data/area_display.json` before the world
  is touched, and is restored on logout, unload and next startup.
- **`CAPlayer.$` is a getter** that resolves `mc.getPlayer(xuid)` on every access; a
  cached handle was a dangling pointer after a reconnect (native crash class).
- **Players are no longer teleported to load chunks.** The only remaining teleport
  returns the player to where they already stood.
- Fill/clone/structure commands run at **console level**: all coordinates are absolute,
  and routing through the player made the operation depend on the vanilla command
  permission (it silently did nothing for simulated players and below-permission users).
  CALL's own `Players.hasPermission` remains the gate.
- `Players.cmd` uses `Player.runcmd`, so no command string contains a player name.
- BDS "0 blocks filled" is treated as a successful no-op instead of an error.
- `BlockType.toString()` no longer emits trailing empty arguments.
- `logFailure()` replaces `logger.error(err)`, which printed `{}`.

### Removed

- `setBossBar` progress bars, teleport-based chunk loading, `loadChunkMode`,
  `maxLoadCheckNum`.


This is a community fork of [superx101/CALL](https://github.com/superx101/CALL), which
is no longer maintained upstream. The 2.0.0 line targets **LeviLamina 26.51.x** with
**LegacyScriptEngine (nodejs) 0.22.4**.

## [2.0.0] - 2026-11-04

### The headline: the plugin did not load on LeviLamina 3, and placement crashed the server

Two defects accounted for almost everything users reported ("nothing works" / "players get
kicked off the server"):

1. **LeviLamina 3 rejected the plugin manifest.** The manifest declared
   `name: "CALL"` while the folder was `plugins/call`; LeviLamina refuses to load a
   plugin whose manifest name does not match its directory name (case-sensitively).
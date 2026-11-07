# Changelog

All notable changes to CALL are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

This is a community fork of [superx101/CALL](https://github.com/superx101/CALL), which
is no longer maintained upstream. The 3.0.0 line targets **LeviLamina 26.51.x** with
**LegacyScriptEngine (nodejs) 0.22.4**.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the platform behaviour these
fixes are based on.

## [3.9.5-beta1]

### Fixed (3.9.5-beta1, build 4)

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
### Fixed (3.9.5-beta1, build 3)

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
### Fixed (3.9.5-beta1, build 2)

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
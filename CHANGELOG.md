# Changelog

All notable changes to CALL are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

This is a community fork of [superx101/CALL](https://github.com/superx101/CALL), which
is no longer maintained upstream. The 3.0.0 line targets **LeviLamina 26.51.x** with
**LegacyScriptEngine (nodejs) 0.22.4**.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the platform behaviour these
fixes are based on.

## [3.3.2] - 2026-11-06

### Fixed - the preview could not read a clipboard at all

`WRN [CALL][Preview] 读取切片失败 <id>: load.missingFile`. A clipboard entry is keyed by its
**structid** and holds one whole area; the files on disk are `<structid>_<ix>_<iz>.mcstructure`,
split by `Structure.getAreas()` into 64-block chunks. The preview was calling
`readBytes(<structid>)`, a file that never exists.

`PreviewScene.gather()` now mirrors `StructureService.load()` step by step (same area
relativity, same `getAreas()` split, same file names), so the preview geometry is by
construction the geometry the paste will use.

### Changed - calibration is a single-variable sweep

`scale` is settled: 1.0 fills exactly one block (both screenshots agree, the docs' "0.5" is a
different context). So `/ca preview calib` now pins `scale=1` and sweeps `offY`
0 / 4 / 8 / 12 / 16 model units (4 units = 0.25 block), which identifies the vertical anchor in
one screenshot instead of two rounds.

### Tests

- Unit 65 (was 61): adds `preview-chunks.test.mjs` - single-chunk small areas, the 2x2 split of
  a 100x100 selection at 0/64, clipboard-relative offsets, and the `<structid>_<ix>_<iz>` id
  format that `save()`/`load()` use.

## [3.3.1] - 2026-11-06

### Fixed - the preview blocks sat half a block too high

The item display was created with the wrong pose. HologramLib's own block-mode example is
`seamless(100.5, 66, -200.5, 0, "minecraft:diamond_block", 0, "0", "-4", "0", "180", "0", "180", "0.5", 2, ...)`:

| | was | now |
|---|---|---|
| rotation | `rotX=0, rotZ=0` | `180 / 180` (block-mode pose) |
| position | cell centre (`y+0.5`) | cell BOTTOM centre (`y` integer) |
| offset | `offY=0` | `offY="-4"` model units (16 = 1 block) |
| creation | `CreateFull` then `SetMode(2)` | `CreateSeamless(..., mode=2, ...)` - one packet, no respawn that can discard the pose |

The invented `previewBlockYOffset` (block units) is replaced by `previewBlockOffsetY`
(model units, default `"-4"`), matching the library's vocabulary.

### Fixed - clicking a tool did nothing

Two independent causes:

1. **Per-player settings were a stale snapshot.** `CAPlayer` copies `default` when the player
   first registers, so players who existed before the tools shipped had no `call:*` bindings at
   all. They are now merged in on login - only for the bundled tool ids, and only when the
   entry is missing, so a player who rebound something keeps it.
2. **Bindings are keyed by the item's display name.** The tools were given a custom name, so
   the lookup key ("§e⚙ 建造助手 · 菜单") never matched the default empty-name entry. Lookup now
   falls back to the empty-name entry, and the given tools no longer set a display name.

### Added

- `/ca tools debug`: prints the held item, its display name, which binding left/right click
  resolves to, the addon state and `texturepack-required` - one command for "my tool does
  nothing".
- `/ca preview calib` now uses the documented pose and sweeps `scale` 0.5 / 0.75 / 1.0.

### Tests

- Unit 61 (was 55): adds `tool-bindings.test.mjs` (name -> empty-name fallback, migration only
  fills gaps, never overwrites, ignores other ids).

## [3.3.0] - 2026-11-06

### Added - real fake-block paste preview

The preview now draws the actual blocks instead of only an outline, using HologramLib's
`itemDisplay` domain (one display per visible block, client side only). My earlier claim that
this was impossible was wrong: I had only looked at DebugShape, which really can only draw
untextured geometry. Thanks to the HologramLib author for pointing at itemDisplay / sulfur.

- `previewMode`: `ghost` (default, blocks + wireframe) or `wireframe` (outline only).
- Rotating moves the existing displays (`itemDisplaySetPosition` + rotation), it does not
  rebuild the scene.
- Teardown destroys our own ids one by one and **never** calls `itemDisplayDestroyAll()`,
  which would wipe displays belonging to other plugins.

### Performance - culling and budget

One display per block is not free, so every layer has a guard:

- **surface culling**: blocks with all six neighbours occupied are dropped
  (a solid 20x20x20 goes from 8000 to ~2400);
- **`previewMaxBlocks`** (default 2000): above it the preview falls back to the wireframe;
- **`previewBatchSize`** (default 200 per tick): creation is spread over ticks with progress;
- **`previewViewDistance`** (default 64) on every display, and only the previewing player can
  see them (`itemDisplaySetVisiblePlayer`);
- displays are created with hitbox 0, so a preview never eats player clicks.

### Known limitation

Item displays have no block states: stairs/slabs/fences/torches show their default
orientation. Position, size, block type and overall rotation are correct. Documented in
`docs/user/tools.md`.

### Added - calibration and diagnostics

- `/ca preview calib` lays out three candidate scales inside 1x1x1 wireframes so one
  screenshot decides the right `previewBlockScale` (the docs say 0.5, the author's screenshot
  suggests 1.0 - this settles it).
- `/ca preview info`, `/ca preview mode ghost|wireframe`.
- Startup self-test now also creates and destroys one item display, so a library/version
  mismatch is reported instead of failing silently:
  `[CALL] HologramLib 1.35.0 - wireframe + fake blocks ready`.

### Fixed - multi-slice paste stacked every slice on top of each other

`StructureService.load` called `Area3.relative()` on each slice, which zeroes the slice
origin, so copying more than `MAX_LENGTH` (64) blocks in X or Z pasted every slice onto the
same anchor. The clipboard minimum is now passed in (`Clipboard.clipboardMin`) and subtracted
instead, so slices land next to each other - including rotated pastes.

### Tests

- Unit 55 (was 46): adds `preview-surface.test.mjs` (shell culling across slices, air
  filtering, budget truncation keeping the top layers, 90-degree footprint swap, slice
  offsets from the file name, clipboard min/box).
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
# Changelog

All notable changes to CALL are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

This is a community fork of [superx101/CALL](https://github.com/superx101/CALL), which
is no longer maintained upstream. The 3.0.0 line targets **LeviLamina 26.51.x** with
**LegacyScriptEngine (nodejs) 0.22.4**.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the platform behaviour these
fixes are based on.

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
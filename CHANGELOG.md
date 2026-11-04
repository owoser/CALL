# Changelog

All notable changes to CALL are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

This is a community fork of [superx101/CALL](https://github.com/superx101/CALL), which
is no longer maintained upstream. The 3.0.0 line targets **LeviLamina 26.51.x** with
**LegacyScriptEngine (nodejs) 0.22.4**.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the platform behaviour these
fixes are based on.

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
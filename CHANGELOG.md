# Changelog

All notable changes to CALL are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

This is a community fork of [superx101/CALL](https://github.com/superx101/CALL), which
is no longer maintained upstream. The 3.0.0 line targets **LeviLamina 26.51.x** with
**LegacyScriptEngine (nodejs) 0.22.4**.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the platform behaviour these
fixes are based on.

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
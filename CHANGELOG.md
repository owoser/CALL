# Changelog

All notable changes to CALL are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
uses [Semantic Versioning](https://semver.org/).

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
   The console showed only "无法加载 call 的 Manifest / 模组名称 CALL 与文件夹 call 不匹配"
   and none of CALL's code ever ran.
   *Fixed*: the plugin is `CALL` everywhere, and the build derives the archive folder
   and deploy target from a single constant.

2. **`mc.setStructure()` crashes the server on this platform.** Verified on
   LL 26.51.x + LSE 0.22.x with a live harness:
   - `mc.getStructure()` works and returns correct NBT;
   - `mc.setStructure()` with engine-captured NBT silently does nothing;
   - `mc.setStructure()` with a hand-built template causes an **access violation**
     inside `StructureTemplate::placeInWorld` (0xC0000005, null deref) - the process
     dies and every connected player is dropped. This fired on every paste and every
     generated shape.
   *Fixed*: CALL no longer calls it. Structures are captured with `mc.getStructure()`
   into CALL's own `.mcstructure` files and restored by writing blocks with
   `Block.setNbt()`, yielding to the scheduler every N blocks.

### Added

- `scripts/build.mjs` - plain-Node build (gulp removed; it no longer installs on
  current Node): compile, assemble, vendor the production dependency closure, emit
  `manifest.json`/`package.json`/`index.js`, generate `tooth.json`, zip, deploy.
- `scripts/zip.mjs` - dependency-free, reproducible ZIP writer.
- `scripts/fetch-types.mjs` + committed `types/lse/` - the official
  `@levimc-lse/types` package is not published to npm, so the declarations are vendored
  from LiteLDev/legacy-script-engine-api at a pinned commit.
- `tests/live/` + `scripts/test-live.mjs` - one-command live integration suite
  (16 assertions: slicing geometry, capture, structure IO, shape placement,
  copy -> paste) that boots a real server and grades the console output.
- `scripts/dev-run-server.mjs` - headless dev server with a file-based console inbox.
- `scripts/check-config.mjs` - validates `configs.json` against `check.json`.
- `core/src/common/Paths.ts` - resolves the plugin root from its own module location
  instead of the hardcoded `./plugins/call`, and pre-creates every runtime directory.
- `core/src/util/Safe.ts` - containment for every engine callback boundary
  (`safeCall`, `runAsync`, tracked intervals).
- `core/src/util/Msg.ts` - the single outgoing-message path; drops empty/oversized
  text and refuses `TextObject` payloads that are not rawtext JSON.
- `core/src/io/NbtCodec.ts` - byte-level NBT reader/writer (handles TAG_Int_Array,
  which LSE's JS NbtCompound cannot index) and big-endian <-> little-endian conversion.
- New configuration keys: `areaDisplayMode`, `areaTextTipInterval`, `maxPlaceBlocks`,
  `placeBatchBlocks`, `loadChunkMode`.

### Changed

- **Selection display is non-destructive by default** (`areaDisplayMode: "particle"`).
  1.6.1 always replaced a world block with a temporary `minecraft:structure_block`;
  a crash or `ll reload` left those blocks behind permanently. The legacy behaviour is
  still available, but it is journalled to `userdata/data/area_display.json` and is
  restored on unload and on the next start.
- **`userdata/data/nbt` is created at build and startup time.** It never existed, so
  every `NBTService.save` threw "cannot open file for write" - which is why copy, save
  and undo did nothing at all.
- Structure writes are synchronous (`writeSync`) instead of fire-and-forget async, so a
  paste can no longer read a half-written file.
- `StructureService.save()/load()` now really await their traversal; 1.6.1 launched
  every slice of a multi-slice operation concurrently.
- `traversal()` always restores `forbidCmd` and removes the boss bar (it had no
  `finally`, so a failure left the player stuck in "wait for the operation").
- `Config.get()` returns null for a missing dotted path instead of the parent object.
- Legacy `structures.json` records missing `redoList`/`copy` are normalised on read,
  so old player data keeps working.
- `Translator` reads `.lang` files with `fs` (the old code called
  `File.getFilesList()` at import time, got `undefined`, and the resulting TypeError
  prevented the whole plugin from loading) and returns the key for missing entries
  instead of throwing inside `sprintf`.
- The plugin root, version and language directory are resolved at runtime; nothing is
  hardcoded to `plugins/call` any more.
- `license` in package.json corrected to GPL-3.0-or-later to match the LICENSE file.
- Removed unused/fake dependencies (`"fs": "^0.0.1-security"`, axios, fs-extra,
  prismarine-nbt, unzipper) and the whole gulp toolchain.

### Fixed

- Console/`/ca` subcommand `tool` fell through into `setting` (missing `return`).
- Command registration now logs whether `/call` actually went live instead of ignoring
  the result of `setup()`.
- `loadChunk()` no longer teleports the player into the middle of a solid region
  (it lands above it, and `loadChunkMode: "poll"` disables the teleport entirely).
- `StructureService.tp()` no longer throws when there is no saved position.

### Known limitations

- Per-block restore is O(blocks). Very large regions are rejected with a clear message
  (`maxPlaceBlocks`) rather than freezing the server.
- Mirror/rotation are accepted by the paste/load commands but current per-block restore
  writes the captured orientation as-is.
- Import/export still shells out to `bin/CALL-CLI.exe`; that path has not been
  re-verified on LL3 yet.

## [1.6.1] and earlier

See the upstream repository history.

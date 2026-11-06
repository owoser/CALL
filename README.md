# CALL

[![CI](https://github.com/owoser/CALL/actions/workflows/ci.yml/badge.svg)](https://github.com/owoser/CALL/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-owoser.github.io%2FCALL-2ea44f)](https://owoser.github.io/CALL/)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/owoser/CALL?label=release)](https://github.com/owoser/CALL/releases/latest)

**Construct Assistant for LeviLamina** - a building / region tool for Bedrock Dedicated
Server, ported to **LeviLamina 26.51.x** + **LegacyScriptEngine (nodejs) 0.22.4**.

📖 **文档 / Documentation: <https://owoser.github.io/CALL/>**
（[安装](https://owoser.github.io/CALL/#/user/install) ·
[配置](https://owoser.github.io/CALL/#/user/config) ·
[更新日志](https://owoser.github.io/CALL/#/other/update)）

This is a maintained community fork of [superx101/CALL](https://github.com/superx101/CALL)
(GPL-3.0). Upstream is unmaintained; the 2.0.0 line is the LL3 port. See
[CHANGELOG.md](./CHANGELOG.md) for what changed and why, and
[docs/MIGRATION-2.0.md](./docs/MIGRATION-2.0.md) if you are coming from 1.6.1.

---

## Why this fork exists

On LeviLamina 3 the 1.6.1 release did not work at all, for two independent reasons:

1. LeviLamina 3 refuses to load a plugin whose `manifest.json` `name` differs from its
   folder name - and the release installed `name: "CALL"` into `plugins/call`.
   The plugin never started.
2. `mc.setStructure()` - used by every paste and every generated shape - **crashes the
   server** on this platform (access violation inside `StructureTemplate::placeInWorld`),
   dropping every connected player.

Three more defects were found by testing against a real server afterwards:

3. `/ca fill` **disconnected the client** because the boss-bar colour 11 is out of range
   for BDS' 8-value `BossBarColor` enum; the server stayed up, which is why it looked
   like only fill was broken.
4. Pasted structures **larger than 787 bytes failed to parse** - the byte-order guess in
   the NBT codec was size dependent.
5. Mirror/rotation were silently ignored when structures were written back block by block.

All of it is fixed and covered by `npm run test:unit` + `npm run test:live`.
See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Requirements

| Component | Version |
|---|---|
| LeviLamina | `>=26.51.9 <26.61.0` |
| LegacyScriptEngine (nodejs) | `>=0.22.4 <0.24.0` |
| BDS | 1.26.51 or newer 1.26.x |

CALL **must** be installed as `plugins/CALL` (folder name == manifest name).
The `ll reload` name is `CALL`.

## Install

**lip / tooth**

```bash
lip install github.com/owoser/CALL
```

**Manual**

1. Download `CALL-<version>.zip` from the releases page.
2. Extract it so that `plugins/CALL/manifest.json` exists.
3. Restart the server.

Check the console: you should see

```
[CALL][command] /call registered (alias: /ca)
[CALL] 2.0.0 ready (root: .../plugins/CALL)
[CALL] Module loaded: call.superx101.basicShape.js
```

## Commands

Everything is available as `/call ...` and `/ca ...`.

| Area | Sub-commands |
|---|---|
| Selection | `area a / b / set / cancel / show` |
| Edit | `fill`, `clear`, `replace`, `move`, `stack`, `mirror`, `rote` |
| Clipboard | `copy`, `paste`, `undo`, `redo` |
| Structures | `save`, `load`, `list`, `delete`, `public`, `private` |
| Shapes | `shape list`, `shape load <pack> <index>` |
| Tools | `tools` (give the bundled wands), `tools list`, `tools status`, `tools pack`, `tools debug` |
| Preview | `preview set / click / move / rotate / mirror / confirm / cancel`, `preview mode`, `preview probe`, `preview trim`, `preview info` |
| Misc | `menu`, `tool`, `texture`, `block`, `setting`, `help`, `on`, `off` |
| Console | `add <player>`, `ban <player>`, `list`, `import`, `export`, `shape list` |

## Tool items and the paste preview

CALL ships its own addon (`assets/addon/CALL_Tools_BP` + `CALL_Tools_RP`) defining five items
in the `call:` namespace - no vanilla id is reused, so nothing can collide with another pack:

| Item | Left click | Right click |
|---|---|---|
| `call:gear` | - | open the menu |
| `call:wand_select` | point A | point B |
| `call:wand_copy` | - | copy the selection |
| `call:wand_paste` | - | paste at the clicked block |
| `call:wand_preview` | move anchor | set anchor / rotate 90 degrees (sneak = confirm) |

`/ca tools` hands them out (creative only, no recipe). The packs are installed into
`behavior_packs`/`resource_packs` and enabled in the world pack lists on first start, then one
restart is required; the console says so. Clients must receive the resource pack for the icons
to show - set `texturepack-required=true` or hand out `/ca tools pack` (`.mcaddon`).

The selection outline and the paste preview are drawn **client side** through HologramLib
(DebugShape shapes and item displays): nothing is written to the world, the preview is visible
to the previewing player only, and teardown never touches displays belonging to other plugins.

The preview, the outline, the undo snapshot and the actual paste are driven by one cell mapping
(`transformCell` in `core/src/structure/Rotate.ts`, the same table `transformLayout` writes
with), so what you see is exactly what gets pasted. Rotation is anchored at the **minimum
corner of the paste box**, which is the block you clicked: turning the clipboard rearranges it
inside the box and swaps width/depth at 90°, but never slides the box sideways. Preview blocks
are not model-rotated - the paste does not turn block states, so the ghost shows the facing that
will really be written.

## Configuration

Full reference: **<https://owoser.github.io/CALL/#/user/config>**

`plugins/CALL/config/configs.json` (JSON with comments). Since 3.1 the layout is
`assets/` (read-only resources) + `config/` (your configuration) + `data/` (your data);
an existing install is migrated automatically on first start.

Keys added in 2.0.0 / 3.x:

| Key | Default | Meaning |
|---|---|---|
| `areaDisplayMode` | `"wireframe"` | `wireframe` (server-side box, everyone sees it, no world writes) / `particle` / `text` / `structure_block` / `off`. |
| `toolItems` | `true` | Install and enable the bundled tool items (first start needs one restart). |
| `previewMode` | `"ghost"` | `ghost` = real fake-block preview, `wireframe` = outline only. |
| `previewMaxBlocks` | `2000` | Surface-block budget; above it the preview falls back to the outline. |
| `previewBlockYCorrection` | `0.4149` | Vertical alignment of the preview blocks, in blocks (calibrated). |
| `areaTextTipInterval` | `1000` | Selection HUD refresh, ms (250-10000). |
| `maxPlaceBlocks` | `40000` | Refuse a single restore larger than this instead of freezing. |
| `placeBatchBlocks` | `600` | Blocks written between scheduler yields. |
| `chunkLoader` | `"tickingarea"` | how chunks are force-loaded (`none` to disable). |
| `chunkLoadTimeout` | `4000` | how long to wait for them, ms. |

Validate the pair offline with `npm run check:config`.

## Data

~~~
plugins/CALL/
  core/                   compiled program
  assets/                 read-only: lang/, icons, schemas, bin/CALL-CLI.exe
  config/                 your configuration
    configs.json          global config (documented, with comments)
    userlist.json         whitelist
    permission.json       file-based whitelist
  data/                   your data
    nbt/                  .mcstructure slice files (1.x compatible)
    shapes/               third-party shape packs
    import/ export/       import/export staging
    settings.json         per-player settings
    structures.json       per-player structure index
    area_display.json     crash journal for the selection highlight
  node_modules/           installed by LSE on first start (npm install --omit=dev)
~~~

> 3.0.x and earlier nested all of this under `userdata/`. 3.1.0 flattens it to
> `assets/` + `config/` + `data/` and migrates an existing install automatically on
> first start.

## Building

```bash
npm ci
npm run fetch-types     # re-vendor LSE declarations (only when bumping LSE)
npm run build           # -> dist/CALL-2.0.0.zip
npm run typecheck
npm run check:config
```

`npm run fetch-types` needs `--use-system-ca` on machines behind a TLS-inspecting proxy;
the npm script already passes it.

## Testing against a real server

```bash
# build.json: { "bdsDir": "D:/path/to/server", "pluginDir": "CALL" }
npm run deploy          # build + copy into <bdsDir>/plugins/CALL
npm run test:unit       # offline: NBT codec + mirror/rotation (no server needed)
npm run test:live       # boots the server, runs tests/live, prints PASS/FAIL
npm run server:dev      # headless server with a console inbox (.console-in)
```

There is exactly **one** server: `build.json -> bdsDir` is the single source of truth for
deploy, `test:live` and the real-fixture unit tests. Keep no copy of a server inside the
repository - `dist/` is build output and `plugins/CALL/config` + `plugins/CALL/data` belong
to that server, so `npm run deploy` moves them aside and puts them back instead of wiping them.

`npm run test:live` is the regression net for the placement work: it asserts slicing
geometry, structure capture, `.mcstructure` round trips, shape placement and
copy -> paste, all against a real LeviLamina process.

## Credits

- Original plugin, design and documentation: **superx101** (GPL-3.0).
- LL3 / LSE 0.22 port: **owoser**.

Licensed under GPL-3.0-or-later - see [LICENSE](./LICENSE).
## Known limitations

- Restoring a region writes the primary block layer only: **block entity contents**
  (chests, signs, banners…) are not restored, and **waterlogged** blocks come back dry.
- A single restore is capped by `maxPlaceBlocks` (default 40000). Larger regions are
  refused with a clear message instead of stalling a tick; raise the cap at your own risk.
- `particle` selection display has not been confirmed to render on this platform;
  `structure_block` (the default) is the verified one.
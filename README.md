# CALL

**Construct Assistant for LeviLamina** - a building / region tool for Bedrock Dedicated
Server, ported to **LeviLamina 26.51.x** + **LegacyScriptEngine (nodejs) 0.22.4**.

This is a maintained community fork of [superx101/CALL](https://github.com/superx101/CALL)
(GPL-3.0). Upstream is unmaintained; the 2.0.0 line is the LL3 port. See
[CHANGELOG.md](./CHANGELOG.md) for what changed and why, and
[docs/MIGRATION-2.0.md](./docs/MIGRATION-2.0.md) if you are coming from 1.6.1.

---

## Why 2.0.0 exists

On LeviLamina 3 the 1.6.1 release did not work at all, for two independent reasons:

1. LeviLamina 3 refuses to load a plugin whose `manifest.json` `name` differs from its
   folder name - and the release installed `name: "CALL"` into `plugins/call`.
   The plugin never started.
2. `mc.setStructure()` - used by every paste and every generated shape - **crashes the
   server** on this platform (access violation inside `StructureTemplate::placeInWorld`),
   dropping every connected player.

Both are fixed; the second by never calling that API again.

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
| Misc | `menu`, `tool`, `texture`, `block`, `setting`, `help`, `on`, `off` |
| Console | `add <player>`, `ban <player>`, `list`, `import`, `export`, `shape list` |

## Configuration

`plugins/CALL/userdata/config/configs.json` (JSON with comments). Keys added in 2.0.0:

| Key | Default | Meaning |
|---|---|---|
| `areaDisplayMode` | `"particle"` | `particle` / `text` / `structure_block` / `off`. Non-destructive by default. |
| `areaTextTipInterval` | `1000` | Selection HUD refresh, ms (250-10000). |
| `maxPlaceBlocks` | `40000` | Refuse a single restore larger than this instead of freezing. |
| `placeBatchBlocks` | `600` | Blocks written between scheduler yields. |
| `loadChunkMode` | `"teleport"` | `poll` never moves the player to load chunks. |

Validate the pair offline with `npm run check:config`.

## Data

```
plugins/CALL/
  config/                 shipped defaults: configs schema, icons, lang
  userdata/
    config/               your configs.json, userlist.json
    data/
      nbt/                .mcstructure slice files (1.x compatible)
      settings.json       per-player settings
      structures.json     per-player structure index
      area_display.json   crash journal for legacy structure_block display
    plugins/              third-party shape packs
    import/ export/       import/export staging
```

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
npm run test:live       # boots the server, runs tests/live, prints PASS/FAIL
npm run server:dev      # headless server with a console inbox (.console-in)
```

`npm run test:live` is the regression net for the placement work: it asserts slicing
geometry, structure capture, `.mcstructure` round trips, shape placement and
copy -> paste, all against a real LeviLamina process.

## Credits

- Original plugin, design and documentation: **superx101** (GPL-3.0).
- LL3 / LSE 0.22 port: **owoser**.

Licensed under GPL-3.0-or-later - see [LICENSE](./LICENSE).

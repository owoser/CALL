# Migrating from CALL 1.6.1 to 2.0.0

2.0.0 is a port to LeviLamina 3 / LegacyScriptEngine 0.22. It is **not** backward
compatible with LiteLoaderBDS 1.x servers, but it is designed to keep your data.

## What you must do

1. Install the plugin as **`plugins/CALL`**. LeviLamina 3 refuses to load a plugin
   whose `manifest.json` `name` does not match its folder name (case-sensitively).
   If you kept a `plugins/call` folder from 1.x, delete it.
2. Make sure `legacy-script-engine-nodejs >= 0.22.4` and `LeviLamina >= 26.51.9`.
3. Restart the server. Hot-reloading an old install does not work; the manifest changed.

## What carries over

| Data | Status |
|---|---|
| `config/configs.json` | Read as-is. New keys get defaults. |
| `config/userlist.json` | Unchanged. |
| `data/settings.json` | Unchanged. |
| `data/structures.json` | Read as-is; records missing `redoList`/`copy` are repaired on read. |
| `data/nbt/*.mcstructure` | Read as-is - same format, same ids. |
| Third-party shape packs in `data/shapes/` | Still loaded. |

## Behaviour changes you should know about

### Selection display no longer touches the world

1.6.1 drew the selection by replacing a block above your build with a temporary
`minecraft:structure_block`. If the plugin crashed, was hot-reloaded, or the server was
killed, that block stayed in the world permanently and could overwrite player builds.

The default is now `areaDisplayMode: "particle"` (a particle outline, no world writes).
Options:

- `"particle"` - default
- `"text"` - only the size hint
- `"structure_block"` - the old behaviour, now journalled and restored
- `"off"`

### Placement is slower for very large regions

Because `mc.setStructure()` crashes the server, restored structures are written block by
block with scheduler yields between batches. Small and medium builds are unaffected; a
single restore larger than `maxPlaceBlocks` (default 40000 blocks) is rejected with a
clear message instead of stalling the server. Raise it at your own risk.

### Chunk loading

`loadChunkMode` defaults to `"teleport"` (the 1.x behaviour: the player is briefly moved
above the target region to force the chunks in). Set it to `"poll"` if you would rather
have the operation fail than see the player move.

### Removed

- The auto-updater (`call update`, `updateFrom`) - it pointed at the upstream release
  feed and cannot serve this fork. Use lip or the releases page.
- `call reload` - it already threw "deprecated" in 1.6.1; use `ll reload CALL`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Manifest rejected / name mismatch | The folder must be `plugins/CALL`. |
| `[CALL] init failed` | Check `config/configs.json` against `config/check.json` (`npm run check:config`). |
| `/call` unknown | Another plugin owns the name, or the server was not fully started when the plugin registered. The console says which. |
| "structure file missing" on paste | `data/nbt` was wiped; re-copy the region. |

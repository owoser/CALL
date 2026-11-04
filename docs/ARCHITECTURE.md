# CALL architecture notes (LeviLamina 3 / LegacyScriptEngine 0.22)

This document exists because CALL 1.x/2.0 shipped three bugs that each took down the
whole feature they touched, and every one of them was caused by an API whose real
behaviour differed from its documentation. Everything below is **verified on
LeviLamina 26.51.x + LSE 0.22.x** with `npm run test:live` / `npm run test:unit`.

## 1. Rules

1. **Never call `mc.setStructure`.** Details in §2.
2. **Never put an unvalidated value into a packet.** Details in §3.
3. **Never cache a `Player` handle.** Details in §4.
4. **Never move the player to make an operation possible.** Details in §5.
5. **Never send text without a non-empty body** (`Msg.tell` enforces it).
6. **Every engine callback goes through `util/Safe.ts`** (`safeCall` / `runAsync`),
   so a failure is logged with a tag and a stack instead of vanishing.

## 2. `mc.setStructure` crashes the server

| Call | Result |
|---|---|
| `mc.getStructure(pos1, pos2)` | works, correct NBT |
| `mc.setStructure(nbt, pos)` with engine-captured NBT | silently places nothing |
| `mc.setStructure(nbt, pos)` with a hand-built template | **access violation** in `StructureTemplate::placeInWorld` (0xC0000005, null deref) - the process dies |

Consequences: paste and shape generation killed the server on LL3.

What CALL does instead:

- **capture**: `mc.getStructure` → `.mcstructure` bytes in `userdata/data/nbt`;
- **restore**: `core/src/io/NbtCodec.ts` parses those bytes and
  `StructurePlacement.placeLayoutAsync` writes blocks with `Block.setNbt()`, yielding
  every `placeBatchBlocks` (default 600) blocks so no tick stalls;
- **transform**: mirror/rotation are applied in `transformLayout` before writing, because
  the game never sees a rotation parameter.

Engine captures store `block_indices` as `TAG_Int_Array`, which LSE's JS `NbtCompound`
cannot index (`getTag(0)` returns undefined), while JS-built shape templates use a list of
ints. The byte parser handles both - do not go back to the NbtCompound API for this.

## 3. Client-visible values must be validated

`Player.setBossBar(uid, title, percent, colour)` in LSE does

```cpp
BossBarColor color = static_cast<BossBarColor>(args[3].asNumber().toInt32()); // no check
pkt->mColor = color;                                                          // -> client
```

and `BossBarColor` is `enum class : uchar` with **8** values (0..7). CALL 1.x/2.0 passed
`11` for fill/clear/replace. The client received an out-of-range colour and dropped the
connection - **the server stayed up**, which is why it looked like "fill kicks players"
while copy/paste (colours 1 and 6) was fine. Each call also emits a fake
`AddActorPacket(mActorType="player")`.

- Progress is now `Msg.tell(..., TIP)` text, throttled to 2/s.
- `core/src/game/SafeArgs.ts` clamps colour/percent/message type/dimension/Y and
  validates block names and states.
- `Msg.tell` drops empty or oversized bodies and refuses `TextObject` (type 9) payloads
  that are not rawtext JSON.

## 4. Player handles are resolved, never cached

`CAPlayer.$` is a getter over `mc.getPlayer(xuid)`. A cached handle became a dangling
pointer after a reconnect, and reading `.realName`/`.langCode` from it was a native
access violation. With a getter, an offline player is simply `null` and the call either
no-ops or throws a normal JS error that `safeCall` swallows.

Commands never embed a player name either: `Players.cmd` uses `Player.runcmd`, and
fill/clone/structure commands run at console level because every coordinate CALL emits is
absolute and CALL has already checked the player's permission itself.

## 5. Chunk loading without teleporting

1.x/2.0 forced chunks in by teleporting the player to the region - every 400ms in
`loadChunk`, every 50ms (up to 15 times) in `Players.tpAsync`. That moved players
mid-operation and could drop them into solid rock.

`core/src/game/Chunks.ts` uses a named `/tickingarea` instead:

1. if both corners already read, do nothing;
2. otherwise add `/execute in <dim> run tickingarea add ... call_<id>`;
3. poll the corners for up to `chunkLoadTimeout`;
4. **always** remove the ticking area, success or failure;
5. at startup, sweep any `call_*` ticking area a killed process left behind.

The only player motion left is `StructureService.tp`, which returns them to where they
already stood.

## 6. Command layer

`core/src/game/Cmd.ts` is the only place that talks to the command system:

| Function | Purpose |
|---|---|
| `run(cmd)` | console command, next tick (never re-enters the dispatcher) |
| `runNow(cmd)` | console command, immediate |
| `runAs(player, cmd)` | `Player.runcmd` - no name interpolation |
| `runAt(pos, cmd)` | `/execute in <dim> positioned ...` |
| `fillCommand / cloneCommand / structureCommand / teleportCommand` | validated builders |

Notes:

- BDS reports "0 blocks filled" as a **failed** command; `FillService` treats it as a
  no-op, otherwise `/ca clear` on an empty region would report an error.
- `/fill` volume is capped at 32768 blocks per command, which is why regions are sliced
  to 64x8x64 slabs.

## 7. Selection display

`areaDisplayMode` (default `structure_block`) draws the selection by placing ONE
temporary structure block:

- only into a verified air block that no other highlight uses - never over a build;
- the displaced block's NBT is journaled to `userdata/data/area_display.json` **before**
  the world is touched, and restored on logout, unload and next startup;
- only the six bounding-box fields are written into the block entity.

`particle` and `text` remain available; particles have not been confirmed to render on
this platform, so they are not the default.

## 8. Test layers

| Layer | Command | Covers |
|---|---|---|
| unit | `npm run test:unit` | NBT codec (against real game files), mirror/rotation, no server needed |
| live | `npm run test:live` | boots a real server, drives the real fill/copy/paste/load paths, asserts blocks and survival |
| visual | manual checklist | selection outline, GUI menus, tool keybinds, whether the client stays connected |

The live layer must exercise the **command path**, not just module calls. The 2.0 release
"passed" 16 module-level tests while `/ca fill` still disconnected clients.

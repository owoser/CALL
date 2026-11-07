/**
 * CALL live integration harness (dev only - never shipped in the release zip).
 *
 * Runs inside a real LeviLamina + LegacyScriptEngine server and exercises the parts of
 * CALL that cannot be verified offline.
 *
 * Findings this harness pinned down (keep them in mind when changing the code):
 *   - mc.getStructure()  -> returns correct NBT.
 *   - mc.setStructure()  -> with engine-captured NBT it silently does nothing; with a
 *                           hand-built template it CRASHES the server inside
 *                           StructureTemplate::placeInWorld (null deref, 0xC0000005).
 *                           CALL therefore must never call it - see StructurePlacement.
 *   - /structure save|load|delete -> work.
 */
"use strict";

const path = require("path");

const RESULTS = [];
function record(ok, name, detail) {
    RESULTS.push({ ok, name, detail: detail || "" });
    const line = (ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : "");
    logger.info("[CALLTEST] " + line);
    if (!ok) console.error("[CALLTEST] " + line);
}
function check(name, fn) {
    try {
        const d = fn();
        record(true, name, typeof d === "string" ? d : "");
        return true;
    } catch (e) {
        record(false, name, e && e.message ? e.message : String(e));
        return false;
    }
}
async function checkAsync(name, fn) {
    try {
        const d = await fn();
        record(true, name, typeof d === "string" ? d : "");
        return true;
    } catch (e) {
        record(false, name, e && e.message ? e.message : String(e));
        return false;
    }
}
function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assertion failed");
}

function loadCallModules() {
    const fs = require("fs");
    const candidates = [path.join(__dirname, "..", "CALL"), path.join(__dirname, "..", "call")];
    const root = candidates.find((c) => fs.existsSync(c));
    assert(root, "CALL plugin not found next to CALLTEST");
    const core = path.join(root, "core", "src");
    return {
        root,
        Paths: require(path.join(core, "common", "Paths.js")).default,
        Config: require(path.join(core, "common", "Config.js")).default,
        Area3: require(path.join(core, "common", "Area3.js")).default,
        Pos3: require(path.join(core, "common", "Pos3.js")).Pos3,
        Structure: require(path.join(core, "common", "Structure.js")).Structure,
        StructureService: require(path.join(core, "structure", "StructureService.js")).default,
        NBTService: require(path.join(core, "structure", "NBTService.js")).default,
        Placement: require(path.join(core, "structure", "StructurePlacement.js")),
        StructureOperation: require(path.join(core, "structure", "StructureOperation.js")).default,
    };
}

// ------------------------------------------------------------------ world utils
const DIM = 0;
let BX = 16;
let BY = 100;
let BZ = 16;

/**
 * Pick a work spot close enough to the simulated player that its chunk stays loaded.
 * Uses concentric slots in a 5x5 grid around the base, stacked upwards, so we never
 * walk outside the loaded region (going further than ~48 blocks used to make
 * mc.getBlock return null and produce misleading failures).
 */
function spot(i) {
    const dx = (i % 5) * 6;
    const dz = (Math.floor(i / 5) % 5) * 6;
    const dy = Math.floor(i / 25) * 8;
    return { x: BX + dx, y: BY + dy, z: BZ + dz };
}
function blockTypeAt(x, y, z) {
    const b = mc.getBlock(x, y, z, DIM);
    return b == null ? "<unloaded>" : b.type;
}
function fillBox(x, y, z, sx, sy, sz, type) {
    for (let dx = 0; dx < sx; dx++)
        for (let dy = 0; dy < sy; dy++)
            for (let dz = 0; dz < sz; dz++)
                mc.setBlock(x + dx, y + dy, z + dz, DIM, type, 0);
}
function findGround(x, z) {
    for (let y = 120; y > -60; y--) {
        const b = mc.getBlock(x, y, z, DIM);
        if (b != null && b.type !== "minecraft:air") return y;
    }
    return null;
}
function fakePlayer(player) {
    return {
        xuid: (player && player.xuid) || "calltest-xuid",
        settings: {
            enable: true, displayProgressBar: false, loadChuckTip: false,
            saveEntity: true, saveUndo: true, saveCopy: true, areaTextShow: false
        },
        forbidCmd: false,
        prePos: null,
        direction: { pitch: 0, yaw: 0 },
        refreshAllChunks() { },
        $: player || null,
    };
}

// --------------------------------------------------------------------- the suite
async function runSuite() {
    let M;
    if (!check("modules.load", () => { M = loadCallModules(); return M.root; })) return;

    check("paths.root", () => {
        assert(require("fs").existsSync(path.join(M.Paths.ROOT, "manifest.json")), "no manifest in " + M.Paths.ROOT);
        return M.Paths.ROOT;
    });
    check("paths.dirs", () => {
        const fs = require("fs");
        const dirs = [M.Paths.ASSETS, M.Paths.CONFIG, M.Paths.DATA, M.Paths.NBT, M.Paths.SHAPES, M.Paths.IMPORT, M.Paths.EXPORT, M.Paths.BIN, M.Paths.LANG];
        for (const d of dirs) {
            assert(typeof d === "string" && d !== "", "Path constant is undefined: " + JSON.stringify(dirs));
            assert(fs.existsSync(d), "missing " + d);
        }
        return "assets + config + data";
    });
    check("config.versions", () => "plugin=" + M.Config.PLUGIN_VERSION + " bds=" + M.Config.SERVER_VERSION + " lse=" + M.Config.LSE_VERSION);

    // The upstream docs point at CALL/config/configs.json, which never existed. Make sure
    // the real file is present, non-empty (i.e. the annotated template rather than a bare
    // "{}") and that its location is printed at startup so users can find it.
    check("config.path", () => {
        const fs = require("fs");
        const file = M.Config.GLOBAL_FILE;
        assert(fs.existsSync(file), "config file missing: " + file);
        const size = fs.statSync(file).size;
        assert(size > 1000, "config file looks like an empty fallback (" + size + " bytes)");
        return file;
    });

    // --- 3.1 layout ---------------------------------------------------------
    check("layout.freshInstall", () => {
        const fs = require("fs");
        const root = M.root;
        const mustExist = [
            "config/configs.jsonc",
            "assets/lang/zh_CN.lang",
            "assets/check.jsonc",
            "assets/configs.default.jsonc",
            "data/nbt",
            "data/shapes",
            "data/import",
            "data/export",
        ];
        for (const rel of mustExist) {
            assert(fs.existsSync(path.join(root, rel)), "missing " + rel);
        }
        // the old mess must be gone
        const mustNotExist = [
            "userdata",
            "userdata/temp",
            "userdata/build",
            "config/update.json",
            "config/url.json",
            "config/check.jsonc",
            "config/configs.default.json",
        ];
        for (const rel of mustNotExist) {
            assert(!fs.existsSync(path.join(root, rel)), "still ships " + rel);
        }
        return "assets/ + config/ + data/, no userdata/";
    });

    check("layout.dependenciesInstalled", () => {
        const fs = require("fs");
        const nm = path.join(M.root, "node_modules");
        assert(fs.existsSync(nm), "node_modules missing: the lean package relies on LSE running npm install");
        const count = fs.readdirSync(nm).filter((n) => !n.startsWith(".")).length;
        assert(count > 0, "node_modules is empty");
        return count + " packages installed by LSE";
    });

    check("config.templateShipped", () => {
        const fs = require("fs");
        const p = path.join(M.root, "assets", "configs.default.jsonc");
        assert(fs.existsSync(p), "missing read-only template used for self-heal: " + p);
        return p;
    });

    await checkAsync("config.pathLogged", async () => {
        const Cmd = require(path.join(M.root, "core", "src", "game", "Cmd.js"));
        void Cmd;
        // read the server log we are running inside of
        const fs = require("fs");
        const logs = path.join(M.root, "..", "..", "logs");
        const file = path.join(logs, "latest.log");
        assert(fs.existsSync(file), "no latest.log to inspect");
        const text = fs.readFileSync(file, "utf8");
        assert(/\[CALL\] config: .*configs\.json/.test(text), "startup log does not print the config path");
        return "startup log prints the config path";
    });

    // --- pure geometry ------------------------------------------------------
    check("slicing.1x1", () => {
        const st = new M.Structure(new M.Area3(new M.Pos3(0, 0, 0, DIM), new M.Pos3(10, 5, 10, DIM)));
        const areas = st.getAreas();
        assert(areas.length === 1 && areas[0].length === 1, "expected 1x1");
        return "1x1";
    });
    check("slicing.128x128", () => {
        const st = new M.Structure(new M.Area3(new M.Pos3(0, 0, 0, DIM), new M.Pos3(127, 10, 127, DIM)));
        const areas = st.getAreas();
        assert(st.xSize === 2 && st.zSize === 2, "xSize/zSize " + st.xSize + "/" + st.zSize);
        assert(areas[0][0].end.x === 63 && areas[1][0].start.x === 64, "x split wrong");
        assert(areas[1][0].end.x === 127, "x tail wrong");
        assert(areas[0][1].start.z === 64 && areas[0][1].end.z === 127, "z split wrong");
        return "2x2 covers 0..127";
    });
    check("coveredArea.aligns", () => {
        const a = M.Placement.coveredArea(new M.Pos3(100, 60, 100, DIM), [3, 4, 5]);
        assert(a.start.x === 100 && a.end.x === 102, "x");
        assert(a.start.y === 60 && a.end.y === 63, "y");
        assert(a.start.z === 100 && a.end.z === 104, "z");
        return "3x4x5";
    });

    // --- world --------------------------------------------------------------
    const sim = mc.spawnSimulatedPlayer("CALLTEST", 0, 120, 0, DIM);
    if (!sim) { record(false, "world.spawnPlayer", "mc.spawnSimulatedPlayer returned undefined"); return; }
    record(true, "world.spawnPlayer", sim.name || "sim");
    await new Promise((r) => setTimeout(r, 4000));

    const ground = findGround(BX, BZ);
    if (ground == null) { record(false, "world.ground", "no loaded ground"); return; }
    BY = Math.min(ground + 20, 180);
    record(true, "world.ground", "y=" + ground + " workBase=" + BY);
    try { sim.teleport(BX + 12, BY + 6, BZ + 12, DIM); } catch (e) { /* optional */ }
    await new Promise((r) => setTimeout(r, 2500));

    // --- capture + vanilla round trip --------------------------------------
    let srcSpot = spot(0);
    check("capture.getStructure", () => {
        fillBox(srcSpot.x, srcSpot.y, srcSpot.z, 3, 2, 3, "minecraft:gold_block");
        const nbt = mc.getStructure(
            new IntPos(srcSpot.x, srcSpot.y, srcSpot.z, DIM),
            new IntPos(srcSpot.x + 2, srcSpot.y + 1, srcSpot.z + 2, DIM), false, true);
        assert(nbt != null, "null");
        assert(String(nbt.toSNBT()).indexOf("gold_block") >= 0, "captured NBT has no gold_block");
        return "palette ok";
    });
    check("vanilla.saveLoad", () => {
        const t = spot(1);
        fillBox(t.x, t.y, t.z, 5, 4, 5, "minecraft:air");
        assert(mc.runcmdEx("/structure save calltest_v " + srcSpot.x + " " + srcSpot.y + " " + srcSpot.z +
            " " + (srcSpot.x + 2) + " " + (srcSpot.y + 1) + " " + (srcSpot.z + 2)).success, "save failed");
        assert(mc.runcmdEx("/structure load calltest_v " + t.x + " " + t.y + " " + t.z).success, "load failed");
        assert(blockTypeAt(t.x, t.y, t.z) === "minecraft:gold_block", "corner=" + blockTypeAt(t.x, t.y, t.z));
        return "corner exact";
    });

    // --- structures survive a restart only through CALL's own files --------
    check("persist.ownFileStore", () => {
        const t = spot(2);
        fillBox(t.x, t.y, t.z, 3, 2, 3, "minecraft:gold_block");
        const area = new M.Area3(new M.Pos3(t.x, t.y, t.z, DIM), new M.Pos3(t.x + 2, t.y + 1, t.z + 2, DIM));
        M.NBTService.save("calltest_persist", area);
        assert(M.NBTService.exists("calltest_persist"), "call did not write its .mcstructure file");
        return M.NBTService.filePath("calltest_persist");
    });

    // --- per-block placement primitive (shapes / imports) -------------------
    check("block.setNbt", () => {
        const t = spot(3);
        fillBox(t.x, t.y, t.z, 2, 2, 2, "minecraft:air");
        const bl = mc.getBlock(t.x, t.y, t.z, DIM);
        assert(bl != null, "no block handle");
        bl.setNbt(new NbtCompound({
            name: new NbtString("minecraft:diamond_block"),
            states: new NbtCompound({}),
            version: new NbtInt(18168865)
        }));
        assert(blockTypeAt(t.x, t.y, t.z) === "minecraft:diamond_block", "type=" + blockTypeAt(t.x, t.y, t.z));
        return "ok";
    });

    // --- CALL end-to-end: NBTService save + load ---------------------------
    await checkAsync("call.nbtRoundTrip", async () => {
        const src = spot(4);
        const dst = spot(5);
        fillBox(src.x, src.y, src.z, 3, 2, 3, "minecraft:emerald_block");
        fillBox(dst.x, dst.y, dst.z, 5, 4, 5, "minecraft:air");
        M.NBTService.save("calltest_rt", new M.Area3(
            new M.Pos3(src.x, src.y, src.z, DIM), new M.Pos3(src.x + 2, src.y + 1, src.z + 2, DIM)));
        assert(M.NBTService.exists("calltest_rt"), "file not written");
        const written = await M.NBTService.loadAsync(fakePlayer(sim), "calltest_rt", new M.Pos3(dst.x, dst.y, dst.z, DIM));
        assert(written > 0, "nothing written by loadAsync");
        assert(blockTypeAt(dst.x, dst.y, dst.z) === "minecraft:emerald_block",
            "placed " + blockTypeAt(dst.x, dst.y, dst.z) + " instead of emerald");
        M.NBTService.del("calltest_rt");
        return "3x2x3 at exact corner";
    });

    // --- shape-style template placed block by block ------------------------
    await checkAsync("call.shapePlacement", async () => {
        const t = spot(8);
        fillBox(t.x, t.y, t.z, 6, 6, 6, "minecraft:air");
        const size = [3, 2, 3];
        const count = size[0] * size[1] * size[2];
        const palette = new NbtList();
        palette.addTag(new NbtCompound({
            name: new NbtString("minecraft:gold_block"),
            states: new NbtCompound({}),
            version: new NbtInt(18168865)
        }));
        const layer0 = new NbtList();
        for (let i = 0; i < count; i++) layer0.addTag(new NbtInt(0));
        const indices = new NbtList();
        indices.addTag(layer0);
        const nbt = new NbtCompound({
            format_version: new NbtInt(2),
            size: new NbtList([new NbtInt(size[0]), new NbtInt(size[1]), new NbtInt(size[2])]),
            structure: new NbtCompound({
                block_indices: indices,
                entities: new NbtList(),
                palette: new NbtCompound({
                    default: new NbtCompound({
                        block_palette: palette,
                        block_position_data: new NbtCompound()
                    })
                })
            })
        });
        const written = await M.Placement.placeNbtAsync(nbt, new M.Pos3(t.x, t.y, t.z, DIM));
        assert(written === count, "wrote " + written + " of " + count);
        assert(blockTypeAt(t.x, t.y, t.z) === "minecraft:gold_block", "corner");
        assert(blockTypeAt(t.x + 2, t.y + 1, t.z + 2) === "minecraft:gold_block", "far corner");
        assert(blockTypeAt(t.x + 3, t.y, t.z) === "minecraft:air", "wrote outside the template");
        return count + " blocks";
    });

    // --- THE fill path (this is what used to kick the client) --------------
    await checkAsync("ca.fillRegion", async () => {
        const M2 = M;
        const FillOperation = require(path.join(M2.root, "core", "src", "structure", "FillOperation.js")).default;
        const t = spot(9);
        fillBox(t.x, t.y, t.z, 8, 4, 8, "minecraft:air");
        // (the corner is re-populated below so the fill argument is a real block)

        const cap = fakePlayer(sim);
        cap.settings.area = {
            start: { x: t.x, y: t.y, z: t.z, dimid: DIM },
            end: { x: t.x + 5, y: t.y + 2, z: t.z + 5, dimid: DIM },
        };
        cap.hasSetArea = true;

        // the fill argument must be a real, non-air block
        mc.setBlock(t.x, t.y, t.z, DIM, "minecraft:stone", 0);
        const sourceBlock = mc.getBlock(t.x, t.y, t.z, DIM);
        assert(sourceBlock != null, "no block handle for the fill argument");
        assert(sourceBlock.type !== "minecraft:air", "fill source block is air");

        // (1) is the generated command itself valid?
        const Cmd = require(path.join(M2.root, "core", "src", "game", "Cmd.js"));
        const from = new M2.Pos3(t.x, t.y, t.z, DIM);
        const to = new M2.Pos3(t.x + 5, t.y + 2, t.z + 5, DIM);
        const cmd = Cmd.fillCommand(from, to, sourceBlock.type, "", "", "", "");
        record(cmd != null && cmd.indexOf("/fill ") === 0, "ca.fillRegion.command", String(cmd));

        // (2) does the console accept it?
        if (cmd) {
            // make it a real change: clear, then fill with stone through the same builder
            fillBox(t.x, t.y, t.z, 8, 4, 8, "minecraft:air");
            const stoneCmd = Cmd.fillCommand(from, to, "minecraft:stone", "", "", "", "");
            const direct = Cmd.runNow(stoneCmd);
            record(direct.ok, "ca.fillRegion.directRun",
                "ok=" + direct.ok + " out=" + String(direct.out).slice(0, 120) + " cmd=" + stoneCmd);
            assert(blockTypeAt(t.x, t.y, t.z) === "minecraft:stone", "direct /fill did not apply");
            fillBox(t.x, t.y, t.z, 8, 4, 8, "minecraft:air");
        }

        // 2.0/3.0.0 used to restore a LATCHED prePos here, moving the player to a
        // position left over from an unrelated earlier operation.
        const beforePos = sim.pos;
        // full path: FillOperation -> FillService -> StructureService.traversal -> /fill
        FillOperation.fill(null, cap, { block: sourceBlock, States: "", FillMode: undefined, states: "" });

        const deadline = Date.now() + 40000;
        let done = false;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
            if (blockTypeAt(t.x + 1, t.y + 1, t.z + 1) !== "minecraft:air") { done = true; break; }
        }
        assert(done, "fill produced no blocks within 40s (checked t+1,+1,+1)");
        assert(blockTypeAt(t.x + 5, t.y + 2, t.z + 5) !== "minecraft:air", "fill did not cover the far corner");
        // Only horizontal drift is meaningful: a simulated player is subject to gravity,
        // and the bug being guarded against was a teleport to a stale operation position
        // (which always shows up as a horizontal jump).
        const afterPos = sim.pos;
        const horizontal = Math.hypot(afterPos.x - beforePos.x, afterPos.z - beforePos.z);
        assert(horizontal < 1.5,
            "the fill teleported the player " + horizontal.toFixed(2) + " blocks horizontally " +
            "(" + JSON.stringify({ from: beforePos, to: afterPos }) + ")");
        return "8x4x8 region filled via /ca fill path, no horizontal teleport";
    });

    // --- selection highlight (structure_block; opt-in since 3.2.0) ---------
    // The default mode is a client-side wireframe now, so this test has to ask for the
    // world-writing mode explicitly - otherwise it was asserting a highlight that is
    // deliberately not drawn any more.
    await checkAsync("ca.selectionDisplay", async () => {
        const fs = require("fs");
        const Config = require(path.join(M.root, "core", "src", "common", "Config.js")).default;
        const AreaDisplayer = require(path.join(M.root, "core", "src", "structure", "AreaDisplayerService.js")).default;
        const previous = Config.get(Config.GLOBAL, "areaDisplayMode", "wireframe");
        Config.set(Config.GLOBAL, "areaDisplayMode", "structure_block");
        try {
        const t = spot(12);
        fillBox(t.x, t.y, t.z, 4, 4, 4, "minecraft:air");

        const cap = fakePlayer(sim);
        const area = new M.Area3(new M.Pos3(t.x, t.y, t.z, DIM), new M.Pos3(t.x + 2, t.y + 1, t.z + 2, DIM));
        cap.settings.area = {
            start: { x: t.x, y: t.y, z: t.z, dimid: DIM },
            end: { x: t.x + 2, y: t.y + 1, z: t.z + 2, dimid: DIM },
        };
        cap.hasSetArea = true;

        const anchor = AreaDisplayer.set(area, cap);
        assert(anchor != null, "no anchor returned");

        // the highlight must appear ABOVE the selection, in air
        let foundAt = -1;
        for (let y = t.y + 2; y <= t.y + 24; y++) {
            if (blockTypeAt(t.x, y, t.z) === "minecraft:structure_block") { foundAt = y; break; }
        }
        assert(foundAt > 0, "no structure_block placed for the highlight");

        const journal = path.join(M.Paths.DATA, "area_display.json");
        assert(fs.existsSync(journal), "highlight was not journaled before touching the world");

        AreaDisplayer.remove(cap);
        assert(blockTypeAt(t.x, foundAt, t.z) === "minecraft:air", "highlight was not restored");
        return "placed at y+" + (foundAt - t.y) + " and restored";
        } finally {
            Config.set(Config.GLOBAL, "areaDisplayMode", previous);
        }
    });

    // --- UNDO of a large region (reported: "structure too large to place block
    //     by block (368640 > 40000)") plus "the snapshot must survive a failure".
    await checkAsync("ca.undoLarge", async () => {
        const fs = require("fs");
        const FillService = require(path.join(M.root, "core", "src", "structure", "FillService.js")).default;
        const BlockType = require(path.join(M.root, "core", "src", "common", "BlockType.js")).default;
        const Config = require(path.join(M.root, "core", "src", "common", "Config.js")).default;
        const Chunks = require(path.join(M.root, "core", "src", "game", "Chunks.js"));
        const Cmd = require(path.join(M.root, "core", "src", "game", "Cmd.js"));
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // 96 x 16 x 96 -> the largest slice is 64x16x64 = 65536, above maxPlaceBlocks
        // (40000), i.e. exactly the situation that made /ca undo impossible.
        const x0 = BX + 520;
        const y0 = BY;
        const z0 = BZ + 520;
        const region = new M.Area3(
            new M.Pos3(x0, y0, z0, DIM), new M.Pos3(x0 + 95, y0 + 15, z0 + 95, DIM));

        const cap = fakePlayer(sim);
        cap.settings.area = {
            start: { x: x0, y: y0, z: z0, dimid: DIM },
            end: { x: x0 + 95, y: y0 + 15, z: z0 + 95, dimid: DIM },
        };
        cap.hasSetArea = true;

        // A previous run may have left this area restored to stone, in which case filling
        // it with stone changes 0 blocks and BDS reports failure. Clear first.
        const seedLease = await Chunks.acquire(region, "undo-seed");
        try {
            assert(await Chunks.waitLoaded(region, 60000), "seed region not loaded");
            for (let dy = 0; dy < 16; dy += 2) {
                Cmd.runNow("/fill " + x0 + " " + (y0 + dy) + " " + z0 + " " +
                    (x0 + 95) + " " + (y0 + dy + 1) + " " + (z0 + 95) + " minecraft:air");
            }
            for (let dy = 0; dy < 16; dy += 2) {
                const res = Cmd.runNow("/fill " + x0 + " " + (y0 + dy) + " " + z0 + " " +
                    (x0 + 95) + " " + (y0 + dy + 1) + " " + (z0 + 95) + " minecraft:stone");
                assert(res.ok, "seed fill failed at dy=" + dy + ": " + res.out);
            }
            assert(blockTypeAt(x0 + 8, y0 + 8, z0 + 8) === "minecraft:stone", "seed did not take");
        } finally {
            seedLease.release();
        }

        // 1) clear: creates the undo snapshot of the stone
        let cleared = null;
        FillService.soildFill(cap, cap.settings.area, new BlockType("minecraft:air", ""),
            new BlockType("", ""), "", (o) => { cleared = o; });
        let waited = 0;
        while (cleared == null && waited < 180000) { await sleep(1000); waited += 1000; }
        assert(cleared != null && cleared.ok, "clear did not complete: " + JSON.stringify(cleared));

        const key = "private." + cap.xuid + ".undoList";
        const listBefore = (Config.get(Config.STRUCTURES, key) || []).length;
        assert(listBefore > 0, "no undo snapshot was created by the clear");

        // 2) a restore that CANNOT succeed must keep the snapshot
        const original = Config.get(Config.GLOBAL, "maxRestoreBlocks", 2000000);
        Config.set(Config.GLOBAL, "maxRestoreBlocks", 40000);
        let firstDone = false;
        M.StructureService.undoPop(cap, () => { firstDone = true; });
        waited = 0;
        while (!firstDone && waited < 180000) { await sleep(500); waited += 500; }
        const listAfterFail = (Config.get(Config.STRUCTURES, key) || []).length;
        const nbtDir = path.join(M.Paths.NBT);
        const filesAfterFail = fs.existsSync(nbtDir) ? fs.readdirSync(nbtDir).length : 0;
        assert(firstDone, "undoPop never reported completion");
        assert(listAfterFail === listBefore, "a failed undo consumed the list entry (data loss): "
            + listBefore + " -> " + listAfterFail);
        assert(filesAfterFail > 0, "a failed undo deleted the snapshot files (data loss)");

        // 3) with the budget restored, the same undo works
        Config.set(Config.GLOBAL, "maxRestoreBlocks", original);
        let undone = false;
        M.StructureService.undoPop(cap, () => { undone = true; });
        waited = 0;
        while (!undone && waited < 300000) { await sleep(1000); waited += 1000; }
        assert(undone, "undoPop (second attempt) never reported completion");

        const verifyLease = await Chunks.acquire(region, "undo-verify");
        await Chunks.waitLoaded(region, 60000);
        const a = blockTypeAt(x0 + 8, y0 + 8, z0 + 8);
        const b = blockTypeAt(x0 + 95, y0 + 15, z0 + 95);
        const c = blockTypeAt(x0 + 48, y0, z0 + 48);
        verifyLease.release();
        assert(a === "minecraft:stone" && b === "minecraft:stone" && c === "minecraft:stone",
            "undo did not restore the region: " + a + " / " + b + " / " + c);

        const listAfterOk = (Config.get(Config.STRUCTURES, key) || []).length;
        assert(listAfterOk === listBefore - 1, "a successful undo did not consume its entry: "
            + listBefore + " -> " + listAfterOk);
        return "96x16x96 clear -> failed undo kept the snapshot -> undo restored it";
    });

    // --- STATEFUL blocks (stairs / log / slab) -------------------------------
    // 3.0.7 could not place ANY block that carries states: palette values were plain JS
    // numbers/strings and LSE's NbtCompound only accepts NbtTag instances, so the whole
    // slice died with "Wrong Type of data to set into NBT Compound!". Every earlier test
    // used stateless blocks, which is why it went unnoticed.
    //
    // The state NAMES are discovered at runtime (1.26.51 calls the stairs direction
    // "weirdo_direction", not "facing_direction"), so this stays valid across versions.
    const BlockTypeM = require(path.join(M.root, "core", "src", "common", "BlockType.js")).default;
    const statesOf = (block) => {
        if (block == null) return "<none>";
        try {
            return BlockTypeM.nbtToStates(block.getNbt().getTag("states"));
        } catch (e) {
            return "<err " + (e && e.message) + ">";
        }
    };
    const placePlain = (x, y, z, type) => {
        const Cmd = require(path.join(M.root, "core", "src", "game", "Cmd.js"));
        const res = Cmd.runNow("/setblock " + x + " " + y + " " + z + " " + type + " replace");
        assert(res.ok, "setblock " + type + " failed: " + res.out);
        const b = mc.getBlock(x, y, z, DIM);
        assert(b != null, "cannot read back " + type);
        return { type: b.type, states: statesOf(b) };
    };
    /** Derive the four accepted spellings from the canonical, engine-reported string. */
    const spellings = (canonical) => {
        const inner = canonical.replace(/^\[/, "").replace(/\]$/, "");
        const unquoted = inner.replace(/"/g, "");
        return {
            canonical,
            unquoted: "[" + unquoted + "]",
            bare: unquoted,
            token: "[" + inner + "]",
        };
    };

    await checkAsync("ca.fillWithStates", async () => {
        const Cmd = require(path.join(M.root, "core", "src", "game", "Cmd.js"));
        const t = spot(25);
        fillBox(t.x, t.y, t.z, 4, 1, 1, "minecraft:air");

        const probe = placePlain(t.x, t.y, t.z, "minecraft:oak_stairs");
        assert(probe.states !== "[]" && probe.states !== "<none>",
            "oak_stairs reports no states; the test would be vacuous");
        const forms = spellings(probe.states);
        // clear the probe cell: filling a block with its own current state changes 0 blocks
        // and BDS reports that as a failed command
        fillBox(t.x, t.y, t.z, 4, 1, 1, "minecraft:air");

        const cases = [
            [probe.type, forms.canonical, "canonical"],
            [probe.type, forms.unquoted, "unquoted"],
            [probe.type, forms.bare, "no brackets"],
            [probe.type + forms.token, "", "block[states] token"],
        ];
        for (let i = 0; i < cases.length; i++) {
            const [type, states, label] = cases[i];
            const x = t.x + i;
            const from = new M.Pos3(x, t.y, t.z, DIM);
            const to = new M.Pos3(x, t.y, t.z, DIM);
            const cmd = Cmd.fillCommand(from, to, type, states);
            assert(cmd != null, "fillCommand rejected the " + label + " form: " + type + " / " + states);
            const res = Cmd.runNow(cmd);
            assert(res.ok, "fill failed (" + label + "): " + cmd + " :: " + res.out);
            const got = statesOf(mc.getBlock(x, t.y, t.z, DIM));
            assert(got === probe.states, "states differ (" + label + "): expected " + probe.states + " got " + got);
        }
        return "4 spellings accepted; states preserved (" + probe.states + ")";
    });

    await checkAsync("ca.pasteStateful", async () => {
        const src = spot(26);
        const dst = spot(27);
        fillBox(src.x, src.y, src.z, 6, 2, 2, "minecraft:air");
        const stairs = placePlain(src.x, src.y, src.z, "minecraft:oak_stairs");
        const log = placePlain(src.x + 1, src.y, src.z, "minecraft:oak_log");
        assert(stairs.states !== "[]", "oak_stairs has no states to test with");
        assert(log.states !== "[]", "oak_log has no states to test with");

        const area = new M.Area3(new M.Pos3(src.x, src.y, src.z, DIM), new M.Pos3(src.x + 1, src.y, src.z, DIM));
        M.NBTService.save("calltest_stateful", area);

        fillBox(dst.x - 1, dst.y - 1, dst.z - 1, 5, 3, 3, "minecraft:air");
        const written = await M.NBTService.loadAsync(fakePlayer(sim), "calltest_stateful",
            new M.Pos3(dst.x, dst.y, dst.z, DIM), "none", 0);
        assert(written > 0, "nothing written");

        const gotA = statesOf(mc.getBlock(dst.x, dst.y, dst.z, DIM));
        const gotB = statesOf(mc.getBlock(dst.x + 1, dst.y, dst.z, DIM));
        assert(gotA === stairs.states, "stairs states lost: expected " + stairs.states + " got " + gotA);
        assert(gotB === log.states, "log states lost: expected " + log.states + " got " + gotB);
        M.NBTService.del("calltest_stateful");
        return "round-tripped with states: " + stairs.states + " / " + log.states;
    });

    await checkAsync("ca.undoStateful", async () => {
        const FillService = require(path.join(M.root, "core", "src", "structure", "FillService.js")).default;
        const BT2 = require(path.join(M.root, "core", "src", "common", "BlockType.js")).default;
        const t = spot(28);
        fillBox(t.x, t.y, t.z, 3, 1, 1, "minecraft:air");
        const stairs = placePlain(t.x, t.y, t.z, "minecraft:oak_stairs");
        const log = placePlain(t.x + 1, t.y, t.z, "minecraft:oak_log");
        assert(stairs.states !== "[]" && log.states !== "[]", "no states to test with");

        const cap = fakePlayer(sim);
        cap.settings.area = {
            start: { x: t.x, y: t.y, z: t.z, dimid: DIM },
            end: { x: t.x + 1, y: t.y, z: t.z, dimid: DIM },
        };
        cap.hasSetArea = true;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        let cleared = null;
        FillService.soildFill(cap, cap.settings.area, new BT2("minecraft:air", ""),
            new BT2("", ""), "", (o) => { cleared = o; });
        let waited = 0;
        while (cleared == null && waited < 90000) { await sleep(500); waited += 500; }
        assert(cleared != null && cleared.ok, "clear did not complete: " + JSON.stringify(cleared));
        assert(blockTypeAt(t.x, t.y, t.z) === "minecraft:air", "clear left blocks");

        let undone = false;
        M.StructureService.undoPop(cap, () => { undone = true; });
        waited = 0;
        while (!undone && waited < 90000) { await sleep(500); waited += 500; }
        assert(undone, "undo did not complete");

        const gotA = statesOf(mc.getBlock(t.x, t.y, t.z, DIM));
        const gotB = statesOf(mc.getBlock(t.x + 1, t.y, t.z, DIM));
        assert(gotA === stairs.states, "stairs state lost on undo: expected " + stairs.states + " got " + gotA);
        assert(gotB === log.states, "log state lost on undo: expected " + log.states + " got " + gotB);
        return "undo restored states: " + gotA + " / " + gotB;
    });

    // --- chunk lease: must actually hold a ticking area, and free it -----------
    await checkAsync("chunks.lease", async () => {
        const Chunks = require(path.join(M.root, "core", "src", "game", "Chunks.js"));
        const Cmd = require(path.join(M.root, "core", "src", "game", "Cmd.js"));
        // far from the player, so nothing is loaded by accident
        const far = new M.Area3(new M.Pos3(BX + 900, 120, BZ + 900, DIM), new M.Pos3(BX + 960, 127, BZ + 960, DIM));

        const lease = await Chunks.acquire(far, "calltest");
        await Chunks.waitLoaded(far, 45000);
        assert(lease.name != null, "acquire() did not create a ticking area for an unloaded region");

        const list = Cmd.runNow("/tickingarea list all-dimensions");
        assert(String(list.out).indexOf(lease.name) >= 0, "the ticking area is not listed while held");
        assert(Chunks.isLoaded(far), "the region still does not read back after acquire()");

        lease.release();
        lease.release(); // must be idempotent

        const after = Cmd.runNow("/tickingarea list all-dimensions");
        assert(String(after.out).indexOf(lease.name) < 0, "the ticking area was not removed on release()");
        return lease.name + " created, listed, released";
    });

    // --- LARGE region clear (the reported bug: 92x108x113 failed) --------------
    await checkAsync("ca.clearLargeRegion", async () => {
        const FillOperation = require(path.join(M.root, "core", "src", "structure", "FillOperation.js")).default;
        const Cmd = require(path.join(M.root, "core", "src", "game", "Cmd.js"));
        const Chunks = require(path.join(M.root, "core", "src", "game", "Chunks.js"));
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // 96 x 8 x 96 = 6x6 chunks, 400 blocks away from the simulated player
        const x0 = BX + 400;
        const y0 = BY;
        const z0 = BZ + 400;

        // seed with stone; the HARNESS loads the chunks itself so the seed cannot be
        // confused with the behaviour under test
        const seedRegion = new M.Area3(
            new M.Pos3(x0, y0, z0, DIM), new M.Pos3(x0 + 95, y0 + 7, z0 + 95, DIM));
        const seedLease = await Chunks.acquire(seedRegion, "seed");
        // Generating a 6x6 chunk region can take a while on a busy machine: wait
        // explicitly so a slow world does not read as a CALL failure.
        const seeded = await Chunks.waitLoaded(seedRegion, 60000);
        assert(seeded, "seed region still not loaded after 60s (ticking area " + seedLease.name + ")");
        for (const dy of [0, 2, 4, 6]) {
            const res = Cmd.runNow("/fill " + x0 + " " + (y0 + dy) + " " + z0 + " " +
                (x0 + 95) + " " + (y0 + dy + 1) + " " + (z0 + 95) + " minecraft:stone");
            assert(res.ok, "seed fill failed at dy=" + dy + ": " + res.out);
        }
        assert(blockTypeAt(x0, y0, z0) === "minecraft:stone", "seed did not take");
        seedLease.release();

        const cap = fakePlayer(sim);
        cap.settings.area = {
            start: { x: x0, y: y0, z: z0, dimid: DIM },
            end: { x: x0 + 95, y: y0 + 7, z: z0 + 95, dimid: DIM },
        };
        cap.hasSetArea = true;

        const hasCallArea = () => /call_[A-Za-z0-9_]+/.test(String(Cmd.runNow("/tickingarea list all-dimensions").out));

        // Drive the same code FillOperation.clear uses, but capture the outcome so a
        // failure reports WHY (slabs / failed / notLoaded) instead of just "left blocks".
        const FillService = require(path.join(M.root, "core", "src", "structure", "FillService.js")).default;
        const BlockType = require(path.join(M.root, "core", "src", "common", "BlockType.js")).default;
        let outcome = null;
        FillService.soildFill(
            cap,
            cap.settings.area,
            new BlockType("minecraft:air", ""),
            new BlockType("", ""),
            "",
            (o) => { outcome = o; }
        );

        // Wait for the operation's OWN completion callback. Sniffing ticking areas is not
        // valid: there is a gap between slices where no lease is held, which made this
        // test declare "finished" while the fill was still running.
        const finishBy = Date.now() + 240000;
        while (outcome == null && Date.now() < finishBy) {
            await sleep(1000);
        }
        assert(outcome != null, "soildFill never reported completion within 240s");

        // The chunks unload once CALL releases them, so re-load JUST for reading.
        const verifyLease = await Chunks.acquire(new M.Area3(
            new M.Pos3(x0, y0, z0, DIM), new M.Pos3(x0 + 95, y0 + 7, z0 + 95, DIM)), "verify");
        const near = blockTypeAt(x0, y0, z0);
        const far = blockTypeAt(x0 + 95, y0 + 7, z0 + 95);
        const mid = blockTypeAt(x0 + 48, y0 + 4, z0 + 48);
        verifyLease.release();

        assert(near === "minecraft:air" && far === "minecraft:air" && mid === "minecraft:air",
            "large clear left blocks: near=" + near + " far=" + far + " mid=" + mid
            + " outcome=" + JSON.stringify(outcome));
        assert(outcome.ok && outcome.failed === 0, "outcome reports failures: " + JSON.stringify(outcome));

        assert(!/call_[A-Za-z0-9_]+/.test(String(Cmd.runNow("/tickingarea list all-dimensions").out)),
            "ticking areas leaked after the operation");
                return "96x8x96 (6x6 chunks) cleared, lease created and released, outcome=" + JSON.stringify(outcome);
    });

    // --- /ca clear really clears (regression: "invalid block or region: air") ---
    // --- public structure folder (hand managed, hot reloaded) --------------
    await checkAsync("ca.publicStructure", async () => {
        const fs = require("fs");
        const path = require("path");
        const pubRoot = path.join(M.Paths.NBT, "public");
        const folder = "HarnessPublic";
        const dir = path.join(pubRoot, folder);
        fs.mkdirSync(dir, { recursive: true });
        // publish the file the NBT round-trip case captured earlier
        const src = path.join(M.Paths.NBT, "calltest_persist.mcstructure");
        assert(fs.existsSync(src), "the earlier capture is missing: " + src);
        fs.copyFileSync(src, path.join(dir, "publicdemo.mcstructure"));

        const list = M.StructureService.getPublicArr();
        const entry = list.find((e) => e.id === folder);
        assert(entry != null, "public list has no " + folder + ": " + JSON.stringify(list));

        const cap = fakePlayer(sim);
        const st = M.StructureService.getStructureById(cap, folder);
        assert(st != null, "getStructureById returned null for " + folder);
        const lens = st.area.getLens();
        assert(lens[0] > 0 && lens[1] > 0 && lens[2] > 0, "bad size " + JSON.stringify(lens));

        const spot2 = spot(34);
        fillBox(spot2.x, spot2.y, spot2.z, lens[0] + 2, lens[1] + 2, lens[2] + 2, "minecraft:air");
        await M.StructureService.load(
            cap, st, folder, new M.Pos3(spot2.x, spot2.y, spot2.z, DIM), 0, 1,
            "none", "0_degrees", false, true, false, 100, "", () => { }
        );
        let placed = 0;
        for (let dx = 0; dx < lens[0]; dx++) {
            for (let dy = 0; dy < lens[1]; dy++) {
                for (let dz = 0; dz < lens[2]; dz++) {
                    if (blockTypeAt(spot2.x + dx, spot2.y + dy, spot2.z + dz) !== "minecraft:air") placed++;
                }
            }
        }
        assert(placed > 0, "nothing was written from the public structure");
        fs.rmSync(dir, { recursive: true, force: true });
        return "listed + loaded " + lens.join("x") + " (" + placed + " blocks)";
    });
    // --- public structure through the COMMAND path (the menu does exactly this) ---
    // --- public structure resolved the way /ca load resolves it --------------
    await checkAsync("ca.publicLoadCommand", async () => {
        const fs = require("fs");
        const path = require("path");
        const folder = "HarnessCmd";
        const dir = path.join(M.Paths.NBT, "public", folder);
        fs.mkdirSync(dir, { recursive: true });
        const src = path.join(M.Paths.NBT, "calltest_persist.mcstructure");
        assert(fs.existsSync(src), "the earlier capture is missing: " + src);
        fs.copyFileSync(src, path.join(dir, "cmddemo.mcstructure"));

        const cap = fakePlayer(sim);
        // This is exactly what the menu click ends up doing: "/ca load <folder name> ..."
        const hit = M.StructureOperation.findId(folder, cap);
        fs.rmSync(dir, { recursive: true, force: true });
        assert(hit != null, "findId threw for the public folder name");
        assert(hit.kind === "scanned", "findId resolved " + folder + " as " + hit.kind);
        assert(hit.structid === folder, "findId returned " + hit.structid);
        return "findId -> " + hit.kind + " (" + hit.structid + ")";
    });
    await checkAsync("ca.clearRegion", async () => {
        const FillOperation = require(path.join(M.root, "core", "src", "structure", "FillOperation.js")).default;
        const t = spot(19);
        fillBox(t.x, t.y, t.z, 4, 3, 4, "minecraft:stone");

        const cap = fakePlayer(sim);
        cap.settings.area = {
            start: { x: t.x, y: t.y, z: t.z, dimid: DIM },
            end: { x: t.x + 3, y: t.y + 2, z: t.z + 3, dimid: DIM },
        };
        cap.hasSetArea = true;

        const before = sim.pos;
        FillOperation.clear(null, cap);

        const deadline = Date.now() + 40000;
        let cleared = false;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
            if (blockTypeAt(t.x, t.y, t.z) === "minecraft:air"
                && blockTypeAt(t.x + 3, t.y + 2, t.z + 3) === "minecraft:air") { cleared = true; break; }
        }
        assert(cleared, "clear left blocks behind: corner=" + blockTypeAt(t.x, t.y, t.z));
        const drift = Math.hypot(sim.pos.x - before.x, sim.pos.z - before.z);
        assert(drift < 1.5, "clear teleported the player " + drift.toFixed(2) + " blocks");
        return "4x3x4 cleared through the /ca clear path";
    });

    // --- ASYMMETRIC round trip: the test that would have caught the 3.0.0
    //     transposition. The old copy/paste case used 4x2x4 (sx === sz) with markers
    //     only on the first and last index, both of which survive any axis permutation.
    await checkAsync("ca.asymmetricXy", async () => {
        const src = spot(13);
        const dst = spot(14);
        // 3 (X) x 2 (Y) x 1 (Z) - six different materials, one per cell
        const mats = [
            "minecraft:stone", "minecraft:gold_block", "minecraft:diamond_block",
            "minecraft:iron_block", "minecraft:emerald_block", "minecraft:lapis_block",
        ];
        fillBox(src.x, src.y, src.z, 4, 3, 2, "minecraft:air");
        let i = 0;
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 3; x++) {
                mc.setBlock(src.x + x, src.y + y, src.z, DIM, mats[i++], 0);
            }
        }
        M.NBTService.save("calltest_ax", new M.Area3(
            new M.Pos3(src.x, src.y, src.z, DIM), new M.Pos3(src.x + 2, src.y + 1, src.z, DIM)));
        fillBox(dst.x - 1, dst.y - 1, dst.z - 1, 6, 5, 4, "minecraft:air");
        await M.NBTService.loadAsync(fakePlayer(sim), "calltest_ax", new M.Pos3(dst.x, dst.y, dst.z, DIM), "none", 0);

        const wrong = [];
        let n = 0;
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 3; x++) {
                const got = blockTypeAt(dst.x + x, dst.y + y, dst.z);
                if (got !== mats[n]) wrong.push("(" + x + "," + y + ") expected " + mats[n] + " got " + got);
                n++;
            }
        }
        assert(wrong.length === 0, wrong.join("; "));
        M.NBTService.del("calltest_ax");
        return "3x2x1 with 6 distinct blocks, cell for cell";
    });

    await checkAsync("ca.asymmetricZ", async () => {
        const src = spot(15);
        const dst = spot(16);
        // 1 (X) x 2 (Y) x 3 (Z) - makes Z the long axis so a Y/Z swap cannot pass
        const mats = [
            "minecraft:stone", "minecraft:gold_block", "minecraft:diamond_block",
            "minecraft:iron_block", "minecraft:emerald_block", "minecraft:lapis_block",
        ];
        fillBox(src.x, src.y, src.z, 2, 3, 4, "minecraft:air");
        let i = 0;
        for (let y = 0; y < 2; y++) {
            for (let z = 0; z < 3; z++) {
                mc.setBlock(src.x, src.y + y, src.z + z, DIM, mats[i++], 0);
            }
        }
        M.NBTService.save("calltest_az", new M.Area3(
            new M.Pos3(src.x, src.y, src.z, DIM), new M.Pos3(src.x, src.y + 1, src.z + 2, DIM)));
        fillBox(dst.x - 1, dst.y - 1, dst.z - 1, 4, 5, 6, "minecraft:air");
        await M.NBTService.loadAsync(fakePlayer(sim), "calltest_az", new M.Pos3(dst.x, dst.y, dst.z, DIM), "none", 0);

        const wrong = [];
        let n = 0;
        for (let y = 0; y < 2; y++) {
            for (let z = 0; z < 3; z++) {
                const got = blockTypeAt(dst.x, dst.y + y, dst.z + z);
                if (got !== mats[n]) wrong.push("(y" + y + ",z" + z + ") expected " + mats[n] + " got " + got);
                n++;
            }
        }
        assert(wrong.length === 0, wrong.join("; "));
        M.NBTService.del("calltest_az");
        return "1x2x3 with 6 distinct blocks, cell for cell";
    });

    // --- air in the snapshot must clear the destination --------------------
    await checkAsync("ca.pasteWritesAir", async () => {
        const src = spot(17);
        const dst = spot(18);
        fillBox(src.x, src.y, src.z, 5, 1, 1, "minecraft:air");
        mc.setBlock(src.x, src.y, src.z, DIM, "minecraft:stone", 0);
        mc.setBlock(src.x + 2, src.y, src.z, DIM, "minecraft:stone", 0);
        mc.setBlock(src.x + 4, src.y, src.z, DIM, "minecraft:stone", 0);
        M.NBTService.save("calltest_air", new M.Area3(
            new M.Pos3(src.x, src.y, src.z, DIM), new M.Pos3(src.x + 4, src.y, src.z, DIM)));

        fillBox(dst.x, dst.y, dst.z, 5, 1, 1, "minecraft:gold_block");
        await M.NBTService.loadAsync(fakePlayer(sim), "calltest_air", new M.Pos3(dst.x, dst.y, dst.z, DIM), "none", 0);

        const got = [0, 1, 2, 3, 4].map((d) => blockTypeAt(dst.x + d, dst.y, dst.z));
        const want = ["minecraft:stone", "minecraft:air", "minecraft:stone", "minecraft:air", "minecraft:stone"];
        assert(JSON.stringify(got) === JSON.stringify(want),
            "expected " + want.join(",") + " got " + got.join(","));
        M.NBTService.del("calltest_air");
        return "air cells cleared the destination instead of leaving gold behind";
    });

    // --- rotation/mirror through the real loader --------------------------
    await checkAsync("call.rotateOnLoad", async () => {
        const src = spot(10);
        const dst = spot(11);
        // 3 x 1 x 1 strip: stone at x, air, gold at x+2
        fillBox(src.x, src.y, src.z, 3, 1, 1, "minecraft:air");
        mc.setBlock(src.x, src.y, src.z, DIM, "minecraft:stone", 0);
        mc.setBlock(src.x + 2, src.y, src.z, DIM, "minecraft:gold_block", 0);

        M.NBTService.save("calltest_rot", new M.Area3(
            new M.Pos3(src.x, src.y, src.z, DIM), new M.Pos3(src.x + 2, src.y, src.z, DIM)));

        fillBox(dst.x - 1, dst.y - 1, dst.z - 1, 6, 4, 6, "minecraft:air");
        const written = await M.NBTService.loadAsync(
            fakePlayer(sim), "calltest_rot", new M.Pos3(dst.x, dst.y, dst.z, DIM), "none", 90);
        assert(written > 0, "nothing written");

        // after a 90 degree rotation the strip must run along Z, not X
        const alongX = blockTypeAt(dst.x + 1, dst.y, dst.z) === "minecraft:gold_block"
            || blockTypeAt(dst.x + 2, dst.y, dst.z) === "minecraft:gold_block";
        const alongZ = blockTypeAt(dst.x, dst.y, dst.z + 2) !== "minecraft:air"
            || blockTypeAt(dst.x, dst.y, dst.z + 2) === "minecraft:gold_block";
        assert(!alongX, "rotation 90 left the strip along X");
        assert(alongZ, "rotation 90 did not produce a strip along Z");
        const total = [0, 1, 2].filter((d) => blockTypeAt(dst.x, dst.y, dst.z + d) !== "minecraft:air").length;
        assert(total === 2, "expected 2 solid cells along Z, found " + total);
        M.NBTService.del("calltest_rot");
        return "3x1x1 strip rotated 90";
    });

    // --- CALL end-to-end: copy -> paste ------------------------------------
    await checkAsync("call.copyPaste", async () => {
        const fp = fakePlayer(sim);
        const src = spot(6);
        const dst = spot(7);
        fillBox(src.x, src.y, src.z, 4, 2, 4, "minecraft:emerald_block");
        mc.setBlock(src.x, src.y, src.z, DIM, "minecraft:iron_block", 0);
        mc.setBlock(src.x + 3, src.y + 1, src.z + 3, DIM, "minecraft:diamond_block", 0);
        fillBox(dst.x, dst.y, dst.z, 6, 4, 6, "minecraft:air");

        const st = new M.Structure(new M.Area3(
            new M.Pos3(src.x, src.y, src.z, DIM), new M.Pos3(src.x + 3, src.y + 1, src.z + 3, DIM)));

        let complex = null;
        await new Promise((resolve, reject) => {
            M.StructureService.copy(fp, [st], false, {}, (c) => { complex = c; resolve(); });
            setTimeout(() => reject(new Error("copy timed out")), 40000);
        });
        assert(complex && Object.keys(complex).length > 0, "copy produced nothing");

        const pasteStart = sim.pos;
        await new Promise((resolve, reject) => {
            M.StructureService.paste(fp, new M.Pos3(dst.x, dst.y, dst.z, DIM), { copy: complex }, resolve).catch(reject);
            setTimeout(() => reject(new Error("paste timed out")), 60000);
        });
        const pasteEnd = sim.pos;
        const drift = Math.hypot(pasteEnd.x - pasteStart.x, pasteEnd.z - pasteStart.z);
        assert(drift < 1.5, "paste teleported the player " + drift.toFixed(2) + " blocks horizontally");
        assert(blockTypeAt(dst.x, dst.y, dst.z) === "minecraft:iron_block", "corner=" + blockTypeAt(dst.x, dst.y, dst.z));
        assert(blockTypeAt(dst.x + 3, dst.y + 1, dst.z + 3) === "minecraft:diamond_block", "far corner");
        assert(blockTypeAt(dst.x + 1, dst.y, dst.z + 1) === "minecraft:emerald_block", "body");
        assert(blockTypeAt(dst.x, dst.y + 3, dst.z) === "minecraft:air", "pasted too tall");
        return "4x2x4 copied+paste exact";
    });
}

function finish() {
    const failed = RESULTS.filter((r) => !r.ok);
    logger.info("[CALLTEST] SUMMARY total=" + RESULTS.length + " failed=" + failed.length);
    for (const f of failed) logger.info("[CALLTEST] FAILED: " + f.name + " :: " + f.detail);
    logger.info("[CALLTEST] ALL DONE");
}

mc.listen("onServerStarted", () => {
    setTimeout(() => {
        runSuite()
            .catch((e) => record(false, "suite.crashed", e && e.message ? e.message : String(e)))
            .finally(() => finish());
    }, 6000);
});
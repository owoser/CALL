import Config from "../common/Config";
import AreaOperation from "../structure/AreaOperation";
import { Settings, defaultSettings } from "../temp/Data";
import { ToolItems } from "./ToolItems";
import { describeError } from "../util/Safe";

const warned = new Set<string>();

export default class CAPlayer {
    public xuid: string;
    public settings: Settings;
    public click: boolean;
    public isSetPosA: boolean;
    public hasSetArea: boolean;
    public isDisplayArea: boolean;
    public displayPos: any;
    public forbidCmd: boolean;
    /** Timers owned by this player; cleared on logout/unload. */
    public timers: number[] = [];
    /**
     * Face of the last right-click (Bedrock BlockFace: 0=down 1=up 2=north 3=south 4=west 5=east).
     *
     * The tool pipeline turns an item click into a bound command, and a command has no way to
     * receive the clicked face - so app.ts stores it here just before running the bindings.
     * The adjust wand is the only consumer (one block along that face's normal).
     */
    public lastClickSide: number = -1;

    constructor(xuid: string) {
        let settings: Settings = Config.get(Config.PLAYERS_SETTINGS, `player.${xuid}`);
        if (settings == null) {
            settings = Config.get(Config.PLAYERS_SETTINGS, "default");
        }
        this.xuid = xuid;
        this.settings = settings;
        this.click = false;
        this.isSetPosA = true;
        this.hasSetArea = false;
        this.isDisplayArea = false;
        this.displayPos = null;
        this.forbidCmd = false;
        this.setDefaultSettings();
        // Players who registered before the bundled tools existed have their own snapshot of
        // default.items without the call:* entries, so their tools would silently do nothing.
        if (ToolItems.migrateBindings(this.settings)) {
            this.persistSettings();
        }
    }

    /**
     * The live Player handle, resolved on EVERY access.
     *
     * 1.x/2.0 cached the handle in the constructor (`this.$ = mc.getPlayer(xuid)`).
     * After the player reconnected - or simply logged out while a timer kept a
     * CAPlayer alive - that cache pointed at a freed Player object, and the next
     * `caPlayer.$.anything` read freed memory (native access violation).
     *
     * Returning null when the player is offline turns that crash into an ordinary,
     * catchable exception (or a clean no-op at call sites that check first).
     */
    public get $(): Player | null {
        try {
            return mc.getPlayer(this.xuid) ?? null;
        } catch (e) {
            CAPlayer.warnOnce(this.xuid, "cannot resolve player: " + describeError(e));
            return null;
        }
    }

    /** True when the player is currently online. */
    public get online(): boolean {
        return this.$ != null;
    }

    /**
     * The live handle, or a thrown error naming the player. Use where the operation
     * genuinely cannot continue without a player.
     */
    public require(): Player {
        const player = this.$;
        if (player == null) {
            throw new Error("player " + this.xuid + " is offline");
        }
        return player;
    }

    private static warnOnce(xuid: string, message: string): void {
        if (warned.has(xuid)) return;
        warned.add(xuid);
        try {
            logger.warn("[CALL][CAPlayer] " + xuid + ": " + message);
        } catch {
            // logger unavailable
        }
    }

    public forgetWarnings(): void {
        warned.delete(this.xuid);
    }

    /**
     * Write this player's settings back.
     *
     * Shared by the login-time binding migration and the click-time fallback in
     * ToolOperation: a tool that shipped after the player's snapshot must be usable without
     * waiting for a reconnect.
     */
    public persistSettings(): void {
        try {
            Config.set(Config.PLAYERS_SETTINGS, `player.${this.xuid}`, this.settings);
        } catch (e) {
            describeError(e);
        }
    }

    public setDefaultSettings() {
        Object.keys(defaultSettings).forEach((key) => {
            if (this.settings[key] == null) this.settings[key] = defaultSettings[key];
        });
    }

    public refreshAllChunks() {
        if (!this.settings.refreshChunks) return;
        const player = this.$;
        if (player == null) return;
        try {
            player.refreshChunks();
        } catch (e) {
            describeError(e);
        }
    }

    public saveAll() {
        if (!this.settings.saveArea) {
            AreaOperation.clearArea(this);
        }
        Config.set(Config.PLAYERS_SETTINGS, `player.${this.xuid}`, this.settings);
    }

    /** Clear every timer this player owns. */
    public stopTimers(): void {
        for (const id of this.timers ?? []) {
            try {
                clearInterval(id);
            } catch {
                // ignore
            }
        }
        this.timers = [];
    }
}

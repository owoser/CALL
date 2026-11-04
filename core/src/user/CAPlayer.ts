import Config from "../common/Config";
import AreaOperation from "../structure/AreaOperation";
import { Settings, defaultSettings } from "../temp/Data";
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
    public prePos: any;
    public direction: DirectionAngle;
    /** Timers owned by this player; cleared on logout/unload. */
    public timers: number[] = [];

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
        this.prePos = null;
        this.setDefaultSettings();
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

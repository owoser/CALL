/**
 * Binding lookup shared by the click pipeline and the migration.
 *
 * The upstream convention is "item type -> display name -> command". "No custom name" is the
 * empty string, which is what the bundled tools use - but a renamed tool (or a player naming
 * their own wand) would no longer match anything, and a click would silently do nothing.
 * Keeping both rules here makes them testable without a server.
 */

export type CmdBinding = { cmds: string[]; describe?: string } | undefined;

/**
 * Resolve the binding for one item type.
 *
 * Order:
 *   1. the exact display name (a per-name binding always wins),
 *   2. the unnamed entry,
 *   3. the first entry of that type.
 *
 * Step 3 exists because the display name is NOT a stable identity: a player can rename a tool
 * at an anvil, an old config can carry a slightly different name, and the name is read from the
 * item's NBT (which also drops trailing lines). Without the fallback the item became dead and
 * reported "这个工具还没有绑定", at random, on exactly the tools whose name had drifted.
 */
export function matchBinding<T>(byType: Record<string, T> | null | undefined, name: string): T | null {
    if (byType == null) return null;
    const key = String(name ?? "").trim();
    if (byType[key] != null) return byType[key];
    if (key !== "" && byType[""] != null) return byType[""];
    // Last resort: the type has bindings, so the tool must keep working.
    for (const candidate of Object.keys(byType)) {
        if (byType[candidate] != null) return byType[candidate];
    }
    return null;
}

/**
 * Deep copy of `template` with every key `override` is missing filled in.
 *
 * `override` always wins for keys it has, so a player's or an admin's customisation is never
 * replaced - but a key that only the shipped template knows about still appears. That is what
 * lets a NEW bundled tool reach an old config: the user's `default.items` predates the item,
 * the template does not.
 */
export function mergeDefaults<T>(template: T, override: any): any {
    if (template == null) return cloneValue(override);
    if (override == null) return cloneValue(template);
    if (Array.isArray(template) || Array.isArray(override)) return cloneValue(override);
    if (typeof template !== "object" || typeof override !== "object") return override;

    const out: any = {};
    for (const key of Object.keys(template as any)) out[key] = cloneValue((template as any)[key]);
    for (const key of Object.keys(override)) {
        out[key] = key in (template as any)
            ? mergeDefaults((template as any)[key], override[key])
            : cloneValue(override[key]);
    }
    return out;
}

function cloneValue<T>(value: T): T {
    if (value == null || typeof value !== "object") return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Merge the bundled tools' default bindings into a player's settings.
 *
 * Only the given ids are considered and an existing entry is never overwritten; returns true
 * when something was added so the caller can persist the settings.
 */
export function mergeToolBindings(
    settings: any,
    defaults: any,
    ids: string[],
    kinds: string[] = ["onUseItemOn", "onStartDestroyBlock"]
): boolean {
    const items = defaults?.items;
    if (items == null || settings == null) return false;

    let changed = false;
    for (const kind of kinds) {
        const src = items[kind];
        if (src == null) continue;
        if (settings.items == null) settings.items = {};
        if (settings.items[kind] == null) settings.items[kind] = {};
        const dst = settings.items[kind];

        for (const id of ids) {
            if (src[id] == null) continue;
            if (dst[id] == null) {
                dst[id] = JSON.parse(JSON.stringify(src[id]));
                changed = true;
            }
        }
    }
    return changed;
}

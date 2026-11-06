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
 * Order: exact display name first (so a per-name binding wins), then the unnamed entry.
 */
export function matchBinding<T>(byType: Record<string, T> | null | undefined, name: string): T | null {
    if (byType == null) return null;
    if (byType[name] != null) return byType[name];
    if (name !== "" && byType[""] != null) return byType[""];
    return null;
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

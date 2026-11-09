/**
 * Binding migrations that must run on every stored settings object.
 *
 * `posf` is the raw click point, which lies on the FACE plane of the clicked block: clicking the
 * +Z face of the block at z=-43 yields z=-42. Bindings written against `${posf.x}` therefore
 * selected the neighbouring block (reported as "every wand is one block off"). No block-targeting
 * command ever wanted the face plane, so rewriting `${posf.…}` to `${pos.…}` is what those
 * bindings meant. `${hit}`/`${hitf}` still expose the raw point for anything that needs it.
 *
 * Pure on purpose: the click path must stay testable without a running server.
 */

/** Rewrite every `${posf.…}` in a settings tree; returns how many strings changed. */
export function migratePosfBindings(settings: any): number {
    let changed = 0;
    const walk = (value: any, depth: number): any => {
        if (depth > 6 || value == null) return value;
        if (typeof value === "string") {
            if (value.indexOf("${posf.") < 0) return value;
            changed++;
            return value.split("${posf.").join("${pos.");
        }
        if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1));
        if (typeof value === "object") {
            for (const key of Object.keys(value)) value[key] = walk(value[key], depth + 1);
        }
        return value;
    };
    try {
        walk(settings?.items, 0);
    } catch {
        // a broken settings object must not break a login
    }
    return changed;
}

export default { migratePosfBindings };

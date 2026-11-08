/**
 * Dotted-numeric version comparison ("26.51.9", "1.37.0").
 *
 * Deliberately tiny and dependency free: the plugin has to compare a native mod's version
 * string on startup, and a semver library would be the only reason to ship node_modules.
 * Missing components count as 0, so "26.51" == "26.51.0".
 */
export function cmpVersion(a: string, b: string): number {
    const pa = String(a ?? "").split(/[.+-]/).map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
    const pb = String(b ?? "").split(/[.+-]/).map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const l = pa[i] ?? 0;
        const r = pb[i] ?? 0;
        if (l !== r) return l < r ? -1 : 1;
    }
    return 0;
}

/** `version >= min`; unparsable input counts as 0, so a bad string never passes. */
export function atLeast(version: string, min: string): boolean {
    const v = String(version ?? "").trim();
    if (v === "" || v === "unknown") return false;
    return cmpVersion(v, min) >= 0;
}

export default { cmpVersion, atLeast };

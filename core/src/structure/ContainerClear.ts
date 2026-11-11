/**
 * Empty a container through its CONTAINER API, right before its block is replaced.
 *
 * Replacing a container block makes the engine treat it as destroyed and spill the contents - the
 * "undo litters the field" report. The naive fix (rewriting the block entity NBT) does NOT work:
 * that write is itself the trigger (measured: the clear reported success and the items still
 * appeared). Removing the items slot by slot through `Block.getContainer()` destroys nothing, so
 * the block can be replaced with an empty container and nothing drops.
 */
export function emptyContainerAt(block: any): number {
    if (block == null) return 0;
    try {
        if (typeof block.hasContainer !== "function" || block.hasContainer() !== true) return 0;
        const container = block.getContainer();
        if (container == null) return 0;
        const size = Number(container.size ?? 0);
        if (!Number.isFinite(size) || size <= 0) return 0;
        let cleared = 0;
        for (let i = 0; i < size; i++) {
            try {
                const item = container.getItem(i);
                if (item == null) continue;
                const type = String((item as any).type ?? "");
                if (type === "" || type === "minecraft:air") continue;
                const count = Number((item as any).count ?? 1) || 1;
                if (container.removeItem(i, count) !== false) cleared++;
            } catch {
                // one bad slot must not abort the sweep
            }
        }
        return cleared;
    } catch {
        return 0;
    }
}

const stats = { cleared: 0 };
/** How many containers have been emptied (diagnostics). */
export function containerClearedCount(): number {
    return stats.cleared;
}
/** Same, counting for the debug output. */
export function clearContainerForWrite(block: any): number {
    const n = emptyContainerAt(block);
    if (n > 0) stats.cleared++;
    return n;
}

export default { emptyContainerAt, clearContainerForWrite, containerClearedCount };

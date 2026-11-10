/**
 * Global pacing for batch submissions.
 *
 * HologramLib frames batch packets against a GLOBAL budget (8 packets per tick), so a preview that
 * submits everything at once starves holograms and every other batch user on the server. This
 * sender runs at most `previewBatchPerTick` jobs per tick, round-robin across previews, and leaves
 * the rest of the budget alone.
 *
 * The FIRST chunk of a preview is submitted synchronously (the caller does that), so a small
 * preview still appears instantly; only the follow-up chunks go through the tick queue.
 */

/** One queued submission, tagged with the feature that asked for it. */
interface Job {
    run: () => void;
    /** e.g. "preview:<xuid>" - cancelOwner() drops exactly this owner's jobs. */
    owner: string;
}

const queue: Job[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let perTick = 6;

/** One Bedrock tick. Submitting on the tick boundary is what the library budget counts. */
export const TICK_MS = 50;

function clampPerTick(n: number): number {
    if (!Number.isFinite(n)) return 6;
    return Math.min(8, Math.max(1, Math.floor(n)));
}

function schedule(): void {
    if (timer != null) return;
    timer = setTimeout(() => {
        timer = null;
        drain();
    }, TICK_MS);
}

function drain(): void {
    let budget = perTick;
    while (budget > 0 && queue.length > 0) {
        const job = queue.shift() as Job;
        budget--;
        try {
            job.run();
        } catch (e) {
            try {
                logger.warn("[CALL][batch] " + (e && (e as any).message ? (e as any).message : e));
            } catch {
                // ignore
            }
        }
    }
    if (queue.length > 0) schedule();
}

export const BatchSender = {
    /** `previewBatchPerTick`: jobs per tick, clamped to the library budget headroom. */
    configure(n: number): void {
        perTick = clampPerTick(n);
    },

    perTick(): number {
        return perTick;
    },

    /** Queue one submission for the next tick, optionally tagged with an owner. */
    request(job: (() => void) | Job, owner = ""): void {
        if (typeof job === "function") {
            queue.push({ run: job, owner });
        } else if (job != null && typeof job.run === "function") {
            queue.push({ run: job.run, owner: job.owner ?? owner });
        } else {
            return;
        }
        schedule();
    },

    /**
     * Drop every queued job of one owner.
     *
     * A cancelled preview must stop feeding the library BEFORE its cells are restored: a job that
     * runs after the restore draws the fake blocks straight back, which is the "cancel left a half
     * structure on screen" report.
     */
    cancelOwner(owner: string): number {
        const key = String(owner ?? "");
        if (key === "") return 0;
        const before = queue.length;
        for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].owner === key) queue.splice(i, 1);
        }
        return before - queue.length;
    },

    pending(): number {
        return queue.length;
    },

    /** Queued jobs of one owner (diagnostics / tests). */
    pendingOf(owner: string): number {
        const key = String(owner ?? "");
        let n = 0;
        for (const job of queue) if (job.owner === key) n++;
        return n;
    },

    /** Tests only: run the queue now, ignoring the tick wait. */
    drainNow(): void {
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
        drain();
    },

    reset(): void {
        queue.length = 0;
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
    },
};

export default BatchSender;

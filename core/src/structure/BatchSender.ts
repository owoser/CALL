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

type Job = () => void;

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
            job();
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

    /** Queue one submission for the next tick. */
    request(job: Job): void {
        if (typeof job !== "function") return;
        queue.push(job);
        schedule();
    },

    pending(): number {
        return queue.length;
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

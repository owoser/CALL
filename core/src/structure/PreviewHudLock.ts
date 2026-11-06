/**
 * "Who owns the action bar right now".
 *
 * The selection hint and the preview countdown both want the same HUD line. Rather than let
 * them overwrite each other every second (which flickers), the preview takes a short-lived
 * lock while its countdown is up and the selection hint yields for that beat.
 *
 * Kept in its own module so neither service has to import the other.
 */
const owners = new Set<string>();

export const PreviewHudLock = {
    hold(xuid: string): void {
        if (xuid) owners.add(xuid);
    },
    release(xuid: string): void {
        if (xuid) owners.delete(xuid);
    },
    held(xuid: string): boolean {
        return owners.has(xuid);
    },
    clear(): void {
        owners.clear();
    },
};

export default PreviewHudLock;

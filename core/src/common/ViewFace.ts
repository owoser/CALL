/**
 * Turn where a player is looking into the block face a click would have hit.
 *
 * The adjust wand moves the preview along the normal of the clicked face, and a click on air
 * has no face. Using the view instead keeps the wand usable while flying: look up and it moves
 * up, look east and it moves east.
 *
 * Face ids are Bedrock's and match PreviewOperation.FACE_DELTA:
 *   0 = down (-Y), 1 = up (+Y), 2 = north (-Z), 3 = south (+Z), 4 = west (-X), 5 = east (+X)
 *
 * pitch: -90 straight up .. +90 straight down (Bedrock convention).
 * facing: 0 north, 1 east, 2 south, 3 west (DirectionAngle.toFacing()).
 */
export const VIEW_FACE = {
    DOWN: 0,
    UP: 1,
    NORTH: 2,
    SOUTH: 3,
    WEST: 4,
    EAST: 5,
} as const;

const PITCH_LIMIT = 45;

export function faceFromView(pitch: number, facing: number): number {
    const p = Number(pitch);
    if (!isNaN(p)) {
        if (p <= -PITCH_LIMIT) return VIEW_FACE.UP;
        if (p >= PITCH_LIMIT) return VIEW_FACE.DOWN;
    }
    switch (Math.trunc(Number(facing)) & 3) {
        case 0:
            return VIEW_FACE.NORTH;
        case 1:
            return VIEW_FACE.EAST;
        case 2:
            return VIEW_FACE.SOUTH;
        default:
            return VIEW_FACE.WEST;
    }
}

export default faceFromView;

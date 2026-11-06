/**
 * The 11 keypoints of the OC4 platform, **in the order the model emits them**.
 *
 * Getting this order wrong is invisible in the bounding boxes and fatal for the
 * overlay: the solver still finds a pose for a permuted correspondence (the
 * pontoons are laid out in a near-symmetric triangle), it is just a *rotated*
 * pose — the twin appears as a rigid object that never lines up with the real
 * platform. The order below was resolved against a real photograph
 * (`npm run find:mapping`): the nine pontoon keypoints form three tight
 * triangles of ~6 cm in the model and the same three groups are visibly separate
 * in the image, and the two points that sit well above the pontoon plane are the
 * hub and the tower base.
 *
 * With this order the solver returns 10/11 inliers at 3.6 px on that photo. With
 * the order from `keypoint_mapping.json` — which mixes the annotation names with
 * the coordinate file's names — it returns nothing at all.
 *
 * Frames:
 *  - **Blender world** (Z up, metres) — the frame of `3D_points.json`, produced
 *    by `utils/scripts/postprocess/geometry/utils/3D_points/3D_pts.py`.
 *  - **glTF / three.js** (Y up) — the frame of `OC4.glb`, exported from the same
 *    scene, so `(x, y, z) → (x, z, −y)`. Verified against the asset: every
 *    keypoint lands within 0.5 cm of a mesh vertex (see `npm run verify:frame`).
 */
export interface Point3 {
    x: number;
    y: number;
    z: number;
}

/**
 * Names, in model-output order. The name in brackets is how the annotation
 * config that trained the model (`src/config/annotation.yaml`) calls the same
 * point; the leading name is the one used by `3D_points.json`, which is the file
 * the coordinates come from.
 */
export const KEYPOINT_NAMES = [
    'pontoon_right_3', // 0
    'pontoon_left_3', // 1
    'pontoon_left_1', // 2
    'pontoon_front_1', // 3
    'pontoon_center_front', // 4  [annotation: pontoon_front_2]
    'pontoon_front_2', // 5  [annotation: pontoon_front_3]
    'Hub', // 6
    'pontoon_center_right', // 7  [annotation: pontoon_right_2]
    'pontoon_center_left', // 8  [annotation: pontoon_left_2]
    'pontoon_front_3', // 9  [annotation: pontoon_right_1]
    'pilar_center', // 10
] as const;

/** Blender world coordinates, in the order of `KEYPOINT_NAMES` (metres). */
export const KEYPOINTS_BLENDER: readonly Point3[] = [
    { x: -0.216, y: -0.003, z: 0.341 }, // 0  pontoon_right_3
    { x: 0.218, y: -0.003, z: 0.341 }, // 1  pontoon_left_3
    { x: 0.249, y: 0.051, z: 0.341 }, // 2  pontoon_left_1
    { x: -0.032, y: 0.428, z: 0.341 }, // 3  pontoon_front_1
    { x: 0.001, y: 0.481, z: 0.35 }, // 4  pontoon_center_front
    { x: 0.036, y: 0.429, z: 0.34 }, // 5  pontoon_front_2
    { x: 0.001, y: 0.306, z: 1.145 }, // 6  Hub
    { x: -0.278, y: -0.003, z: 0.35 }, // 7  pontoon_center_right
    { x: 0.28, y: -0.003, z: 0.35 }, // 8  pontoon_center_left
    { x: -0.247, y: 0.051, z: 0.341 }, // 9  pontoon_front_3
    { x: 0.001, y: 0.194, z: 0.788 }, // 10 pilar_center
];

/** Blender world → three.js/glTF (Y up). */
export function toSceneFrame(point: Point3): Point3 {
    return { x: point.x, y: point.z, z: -point.y };
}

/** The 11 keypoints in the frame of `OC4.glb`, i.e. the frame PnP works in. */
export const KEYPOINTS_SCENE: readonly Point3[] = KEYPOINTS_BLENDER.map(toSceneFrame);

/**
 * Height of the pontoon plane in the scene frame.
 *
 * Nine of the eleven keypoints sit on it (Blender z ∈ [0.34, 0.35]), which is
 * what lets the solver start from a planar homography before refining with all
 * of them. It matches reality: the pontoons float at the waterline.
 */
export const PONTOON_PLANE_Y = 0.345;

/** Scene-frame keypoints expressed as (X, Z) on the pontoon plane, plus height. */
export function planeCoordinates(point: Point3): [number, number] {
    return [point.x, point.z];
}

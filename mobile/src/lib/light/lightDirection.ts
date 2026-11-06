/**
 * Turns the estimated light direction into a vector the 3D scene can use.
 *
 * The estimator works in the **camera** frame (that is what the image gives);
 * the twin is rendered in the **model** frame, which the PnP pose relates to the
 * camera. So the direction has to be rotated by Rᵀ before it can drive a
 * `directionalLight`: without that, the light would swing every time the camera
 * turned.
 */
import { rodriguesToMatrix } from '../pose/linalg';
import type { Pose } from '../pose/solvePnP';

export interface LightVector {
    x: number;
    y: number;
    z: number;
}

/**
 * @param azimuthDeg 0 = straight ahead of the camera, positive towards the right.
 * @param elevationDeg above the horizon (0 = horizon, 90 = overhead).
 * @param pose the pose that was current when the estimate was made.
 */
export function lightVectorModelSpace(
    azimuthDeg: number,
    elevationDeg: number,
    pose: Pose | null
): LightVector {
    const azimuth = (azimuthDeg * Math.PI) / 180;
    const elevation = (elevationDeg * Math.PI) / 180;
    // OpenCV camera axes: x right, y down, z forward (into the scene).
    const camera: [number, number, number] = [
        Math.cos(elevation) * Math.sin(azimuth),
        -Math.sin(elevation),
        Math.cos(elevation) * Math.cos(azimuth),
    ];
    if (!pose) return { x: camera[0], y: camera[1], z: camera[2] };

    // `rodriguesToMatrix` maps world → camera, row-major. The inverse of a
    // rotation is its transpose, which is what takes camera → world.
    const r = rodriguesToMatrix(pose.rvec);
    const inverse: [number, number, number] = [
        r[0] * camera[0] + r[3] * camera[1] + r[6] * camera[2],
        r[1] * camera[0] + r[4] * camera[1] + r[7] * camera[2],
        r[2] * camera[0] + r[5] * camera[1] + r[8] * camera[2],
    ];
    return { x: inverse[0], y: inverse[1], z: inverse[2] };
}

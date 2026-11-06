/**
 * Pose (OpenCV convention) → three.js camera.
 *
 * Derivation, because getting it wrong produces an overlay that is subtly
 * rotated and looks "almost right":
 *
 *  - `solvePnP` gives `x_cv = R·X + t`, with `x_cv` in the OpenCV camera frame
 *    (x right, y **down**, z **forward**) and `X` in the scene frame (Y up, the
 *    frame of `OC4.glb`).
 *  - A three.js camera works in (x right, y **up**, z **backward**), so the two
 *    camera frames differ by `D = diag(1, −1, −1)`: `x_view = D·x_cv`.
 *  - For a camera with world rotation `Q` (columns = its local axes in world
 *    coordinates) and position `C`: `x_view = Qᵀ·(X − C)`.
 *
 * Matching terms gives:
 *   Qᵀ = D·R  →  **Q = Rᵀ·D**
 *   −Qᵀ·C = D·t  →  **C = −Rᵀ·t**
 *
 * The vertical FOV is set from the focal length *after* the `object-fit: cover`
 * crop, so the WebGL layer renders exactly the region of the video the user can
 * see. Otherwise the twin is offset by however much the browser cropped.
 */
import * as THREE from 'three';
import { computeCover } from '../geometry';
import { rodriguesToMatrix } from './linalg';
import type { Intrinsics, Pose } from './solvePnP';

/** Rotation matrix of the three.js camera in the scene frame: `Rᵀ·D`. */
export function cameraRotationMatrix(pose: Pose): THREE.Matrix4 {
    // rodriguesToMatrix returns row-major: R[row * 3 + col].
    const R = rodriguesToMatrix(pose.rvec);
    return new THREE.Matrix4().set(
        R[0], -R[3], -R[6], 0,
        R[1], -R[4], -R[7], 0,
        R[2], -R[5], -R[8], 0,
        0, 0, 0, 1
    );
}

/** Camera position in the scene frame: `−Rᵀ·t`. */
export function cameraPosition(pose: Pose): THREE.Vector3 {
    const R = rodriguesToMatrix(pose.rvec);
    const t = pose.tvec;
    return new THREE.Vector3(
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])
    );
}

export interface Viewport {
    /** Size of the WebGL canvas, in CSS pixels. */
    width: number;
    height: number;
    /** Intrinsic size of the video the pose was solved against. */
    sourceWidth: number;
    sourceHeight: number;
}

/**
 * Applies a solved pose to a three.js camera so the twin projects exactly onto
 * the detected keypoints.
 *
 * Returns false when there is not enough information (no video yet), in which
 * case the caller must leave the camera alone.
 */
export function applyPoseToCamera(
    camera: THREE.PerspectiveCamera,
    pose: Pose,
    intrinsics: Intrinsics,
    viewport: Viewport
): boolean {
    if (viewport.width <= 0 || viewport.height <= 0) return false;
    if (viewport.sourceWidth <= 0 || viewport.sourceHeight <= 0) return false;

    const cover = computeCover(
        viewport.sourceWidth,
        viewport.sourceHeight,
        viewport.width,
        viewport.height
    );
    // Focal length in *display* pixels: same conversion as the video's crop.
    const fyDisplay = intrinsics.fy * cover.scale;
    if (!Number.isFinite(fyDisplay) || fyDisplay <= 0) return false;

    camera.fov = (2 * Math.atan(viewport.height / 2 / fyDisplay) * 180) / Math.PI;
    camera.aspect = viewport.width / viewport.height;
    camera.near = 0.01;
    camera.far = 200;

    camera.position.copy(cameraPosition(pose));
    camera.quaternion.setFromRotationMatrix(cameraRotationMatrix(pose));
    // Mutating fov/aspect is not enough: the projection matrix is cached until
    // this is called, and a stale one throws the overlay off by tens of pixels.
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return true;
}

/**
 * Where the pose says each 3D point should appear, in *source* pixels.
 * Used by the overlay as an alignment self-check.
 */
export function projectToSource(
    points: ReadonlyArray<{ x: number; y: number; z: number }>,
    pose: Pose,
    intrinsics: Intrinsics
): Array<[number, number]> {
    const R = rodriguesToMatrix(pose.rvec);
    const t = pose.tvec;
    return points.map((point) => {
        const z = R[6] * point.x + R[7] * point.y + R[8] * point.z + t[2];
        if (Math.abs(z) < 1e-9) return [Number.NaN, Number.NaN];
        const x = R[0] * point.x + R[1] * point.y + R[2] * point.z + t[0];
        const y = R[3] * point.x + R[4] * point.y + R[5] * point.z + t[1];
        return [(intrinsics.fx * x) / z + intrinsics.cx, (intrinsics.fy * y) / z + intrinsics.cy];
    });
}

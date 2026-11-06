/**
 * `solvePnP` in TypeScript: from detected 2D keypoints to the camera pose that
 * makes the 3D twin project exactly onto the real object.
 *
 * The original pipeline used `cv2.solvePnPRansac(..., SOLVEPNP_EPNP)` in Python
 * (`utils/scripts/postprocess/geometry/pnp_solver.py`). This is the same idea,
 * implemented without OpenCV because it has to run on the phone, per frame:
 *
 *   1. **Initial guess** from a planar homography. Nine of the eleven keypoints
 *      lie on the pontoon plane (they float at the waterline), and `H = K[r1 r2 t]`
 *      gives the pose in closed form once `K` is known.
 *   2. **Refinement** with Levenberg-Marquardt over (rvec, tvec), minimising the
 *      reprojection error of *all* the points — including the Hub and the pilar,
 *      which are off the plane and therefore pin down the scale and the tilt.
 *   3. **Robustness** through Huber weights: a single mislabelled keypoint (the
 *      model sometimes puts a pontoon point on the wrong corner) cannot drag the
 *      pose away, which is what RANSAC was doing in the Python version.
 *
 * Everything here is deterministic and side-effect free, so it can be unit
 * tested with synthetic projections (`npm run verify:pose`).
 */
import {
    mat3Inverse,
    mat3Mul,
    mat3Vec,
    matrixToRodrigues,
    rodriguesToMatrix,
    skew,
    solveLinearSystem,
    vec3Cross,
    vec3Dot,
    vec3Length,
    vec3Normalize,
    type Mat3,
    type Vec3,
} from './linalg';
import type { Point3 } from './keypoints3d';

export interface Intrinsics {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
}

export interface Pose {
    /** Rodrigues rotation vector, world → camera (OpenCV: x right, y down, z forward). */
    rvec: Vec3;
    /** Camera position expressed as `X_cam = R·X + t`. */
    tvec: Vec3;
    /** RMS reprojection error of the inliers, in source pixels. */
    rmsError: number;
    inliers: number;
    pairs: number;
}

export interface SolveOptions {
    /** Inlier threshold in pixels. */
    maxReprojectionError?: number;
    maxIterations?: number;
    /** Seed the refinement with the previous frame's pose (much more stable). */
    previousPose?: Pose | null;
}

/** Pixel coordinates are only meaningful within the image. */
const MIN_PAIRS = 4;
const MIN_PAIRS_FOR_PLANE = 4;
/** How close to the plane a point must be to count as coplanar (metres). */
const PLANE_TOLERANCE = 0.02;

/**
 * Pinhole intrinsics from a field of view.
 *
 * The angle is measured across the **longest image side**, which is how camera
 * lenses are quoted and, more importantly, the only reading that survives
 * rotating the phone: the sensor's long axis is the same physical axis whether
 * the camera is held in portrait or landscape. Measuring it across `width`
 * instead halves the focal length in a portrait frame (576×1024 with 68° across
 * the 576 px side implies a 100° vertical field of view, which no phone has),
 * and a wrong focal length biases the recovered distance and tilt.
 */
export function intrinsicsFromFov(width: number, height: number, fovDeg: number): Intrinsics {
    const fov = (fovDeg * Math.PI) / 180;
    const focal = Math.max(width, height) / 2 / Math.tan(fov / 2);
    // Square pixels: one focal length in pixels, both axes.
    return { fx: focal, fy: focal, cx: width / 2, cy: height / 2 };
}

export function projectPoint(point: Point3, pose: Pose, K: Intrinsics): [number, number] {
    const R = rodriguesToMatrix(pose.rvec);
    const camera = mat3Vec(R, [point.x, point.y, point.z]);
    const x = camera[0] + pose.tvec[0];
    const y = camera[1] + pose.tvec[1];
    const z = camera[2] + pose.tvec[2];
    if (Math.abs(z) < 1e-9) return [Number.NaN, Number.NaN];
    return [(K.fx * x) / z + K.cx, (K.fy * y) / z + K.cy];
}

interface Pair {
    point3d: Point3;
    u: number;
    v: number;
}

/** RMS reprojection error of every pair, plus the per-point error. */
function reprojectionErrors(
    pose: Pose,
    pairs: Pair[],
    K: Intrinsics
): { errors: number[]; rms: number } {
    const R = rodriguesToMatrix(pose.rvec);
    const errors: number[] = [];
    let sum = 0;

    for (const pair of pairs) {
        const camera = mat3Vec(R, [pair.point3d.x, pair.point3d.y, pair.point3d.z]);
        const z = camera[2] + pose.tvec[2];
        if (z <= 1e-6) {
            // Behind the camera: a pose that cannot be right, punish it hard.
            errors.push(1e6);
            sum += 1e12;
            continue;
        }
        const u = (K.fx * (camera[0] + pose.tvec[0])) / z + K.cx;
        const v = (K.fy * (camera[1] + pose.tvec[1])) / z + K.cy;
        const error = Math.hypot(u - pair.u, v - pair.v);
        errors.push(error);
        sum += error * error;
    }

    return { errors, rms: Math.sqrt(sum / Math.max(1, pairs.length)) };
}

/** Pose with the smallest reprojection error whose points are all in front. */
function scorePose(pose: Pose, pairs: Pair[], K: Intrinsics): number {
    const { errors, rms } = reprojectionErrors(pose, pairs, K);
    if (errors.some((error) => error > 1e5)) return Number.POSITIVE_INFINITY;
    return rms;
}

/**
 * Pose from a planar homography of the coplanar subset.
 *
 * The decomposition works on plane coordinates `(X, Z)` with the plane
 * translated to `y = 0`, so `H ≈ K [cX cZ t']`, where `cX` and `cZ` are the
 * images of the world X and Z axes and `t'` is the translation of the *plane's*
 * origin.
 *
 * The trap is handedness. `(X, Z)` is **not** a right-handed pair in a Y-up
 * world — `X × Z = −Y` — so the rotation cannot be assembled as
 * `(cX, cZ, cX × cZ)`: that is a proper rotation of a *permuted* world, i.e. a
 * pose with two axes swapped, which reprojects nothing like the real object.
 * Correct assembly puts the image of **Y** in the second column, computed as
 * `cZ × cX`, and re-orthogonalises Z against it. The scene origin then sits
 * `planeY` along +Y from the plane, hence `t = t' − planeY·cY`.
 *
 * The sign of the scale (and therefore the direction of the translation) is the
 * classic two-fold ambiguity: both candidates are returned and scored.
 */
function poseFromHomography(pairs: Pair[], K: Intrinsics): Pose[] {
    if (pairs.length < MIN_PAIRS_FOR_PLANE) return [];

    const planeY = pairs[0].point3d.y;
    const matrix: number[][] = [];
    const rhs: number[] = [];

    for (const pair of pairs) {
        // Plane coordinates: the plane is horizontal, so its basis is (X, Z).
        const X = pair.point3d.x;
        const Z = pair.point3d.z;
        matrix.push([X, Z, 1, 0, 0, 0, -pair.u * X, -pair.u * Z]);
        rhs.push(pair.u);
        matrix.push([0, 0, 0, X, Z, 1, -pair.v * X, -pair.v * Z]);
        rhs.push(pair.v);
    }

    // Least squares: AᵀA h = Aᵀb (h33 fixed to 1).
    const normal: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const target = new Array(8).fill(0);
    for (let row = 0; row < matrix.length; row += 1) {
        for (let i = 0; i < 8; i += 1) {
            target[i] += matrix[row][i] * rhs[row];
            for (let j = 0; j < 8; j += 1) normal[i][j] += matrix[row][i] * matrix[row][j];
        }
    }
    // A pinch of regularisation keeps the system solvable with 4 coplanar points.
    for (let i = 0; i < 8; i += 1) normal[i][i] += 1e-12;

    const h = solveLinearSystem(normal, target);
    if (!h) return [];

    const H: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    const Kinv: Mat3 = [1 / K.fx, 0, -K.cx / K.fx, 0, 1 / K.fy, -K.cy / K.fy, 0, 0, 1];
    const Hp = mat3Mul(Kinv, H);

    const h1: Vec3 = [Hp[0], Hp[3], Hp[6]];
    const h2: Vec3 = [Hp[1], Hp[4], Hp[7]];
    const h3: Vec3 = [Hp[2], Hp[5], Hp[8]];

    const norm1 = vec3Length(h1);
    const norm2 = vec3Length(h2);
    const scale = 2 / Math.max(1e-9, norm1 + norm2);

    const candidates: Pose[] = [];
    for (const sign of [1, -1]) {
        const s = scale * sign;
        const cX: Vec3 = [h1[0] * s, h1[1] * s, h1[2] * s];
        const cZ: Vec3 = [h2[0] * s, h2[1] * s, h2[2] * s];
        // Image of +Y: the frame (X, Y, Z) is right-handed, so cZ × cX = cY.
        const cY = vec3Normalize(vec3Cross(cZ, cX));
        const cZfixed = vec3Normalize(vec3Cross(cX, cY));
        // Columns of R, row-major: R[row * 3 + col].
        const R: Mat3 = [
            cX[0], cY[0], cZfixed[0],
            cX[1], cY[1], cZfixed[1],
            cX[2], cY[2], cZfixed[2],
        ];
        const t: Vec3 = [
            h3[0] * s - planeY * cY[0],
            h3[1] * s - planeY * cY[1],
            h3[2] * s - planeY * cY[2],
        ];
        candidates.push({ rvec: matrixToRodrigues(R), tvec: t, rmsError: 0, inliers: 0, pairs: 0 });
    }
    return candidates;
}

/**
 * Levenberg-Marquardt refinement over (rvec, tvec) with Huber weights.
 *
 * `rvec` is updated on the right (`R ← R·Exp(δ)`), so `∂X_cam/∂δ = −R·skew(X)`,
 * which is the Jacobian used below.
 */
function refine(pairs: Pair[], K: Intrinsics, initial: Pose, options: SolveOptions): Pose {
    const maxIterations = options.maxIterations ?? 20;
    const huberDelta = 3;
    let pose = initial;
    let R = rodriguesToMatrix(pose.rvec);
    let t: Vec3 = [...pose.tvec];

    const huberWeight = (error: number) => (error <= huberDelta ? 1 : huberDelta / error);
    let lambda = 1e-3;
    let currentCost = reprojectionErrors(pose, pairs, K).rms;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const H: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
        const g = new Array(6).fill(0);

        for (const pair of pairs) {
            const X: Vec3 = [pair.point3d.x, pair.point3d.y, pair.point3d.z];
            const rotated = mat3Vec(R, X);
            const Xc: Vec3 = [rotated[0] + t[0], rotated[1] + t[1], rotated[2] + t[2]];
            if (Xc[2] <= 1e-6) continue;

            const invZ = 1 / Xc[2];
            const u = K.fx * Xc[0] * invZ + K.cx;
            const v = K.fy * Xc[1] * invZ + K.cy;
            const ru = u - pair.u;
            const rv = v - pair.v;
            const error = Math.hypot(ru, rv);
            if (!Number.isFinite(error)) continue;
            const weight = huberWeight(error);

            // ∂(u,v)/∂X_cam
            const Jproj = [
                [K.fx * invZ, 0, -K.fx * Xc[0] * invZ * invZ],
                [0, K.fy * invZ, -K.fy * Xc[1] * invZ * invZ],
            ];
            // ∂X_cam/∂δ = −R·skew(X)
            const Rskew = mat3Mul(R, skew(X));
            const J: number[][] = [];
            for (let row = 0; row < 2; row += 1) {
                J.push([
                    -(Jproj[row][0] * Rskew[0] + Jproj[row][1] * Rskew[3] + Jproj[row][2] * Rskew[6]),
                    -(Jproj[row][0] * Rskew[1] + Jproj[row][1] * Rskew[4] + Jproj[row][2] * Rskew[7]),
                    -(Jproj[row][0] * Rskew[2] + Jproj[row][1] * Rskew[5] + Jproj[row][2] * Rskew[8]),
                    Jproj[row][0],
                    Jproj[row][1],
                    Jproj[row][2],
                ]);
            }

            const residual = [ru, rv];
            for (let i = 0; i < 6; i += 1) {
                g[i] += weight * (J[0][i] * residual[0] + J[1][i] * residual[1]);
                for (let j = 0; j < 6; j += 1) {
                    H[i][j] += weight * (J[0][i] * J[0][j] + J[1][i] * J[1][j]);
                }
            }
        }

        // Damped normal equations: (H + λ·diag(H)) δ = −g
        const damped = H.map((row, i) => row.map((value, j) => (i === j ? value * (1 + lambda) + 1e-12 : value)));
        const delta = solveLinearSystem(
            damped,
            g.map((value) => -value)
        );
        if (!delta) {
            lambda *= 10;
            continue;
        }

        const stepR: Vec3 = [delta[0], delta[1], delta[2]];
        const stepT: Vec3 = [delta[3], delta[4], delta[5]];
        const candidateR = mat3Mul(R, rodriguesToMatrix(stepR));
        const candidateT: Vec3 = [t[0] + stepT[0], t[1] + stepT[1], t[2] + stepT[2]];
        const candidate: Pose = {
            rvec: matrixToRodrigues(candidateR),
            tvec: candidateT,
            rmsError: 0,
            inliers: 0,
            pairs: 0,
        };

        const candidateCost = reprojectionErrors(candidate, pairs, K).rms;
        if (candidateCost < currentCost) {
            R = candidateR;
            t = candidateT;
            pose = candidate;
            currentCost = candidateCost;
            lambda = Math.max(1e-6, lambda * 0.5);
            if (vec3Length(stepR) < 1e-7 && vec3Length(stepT) < 1e-6) break;
        } else {
            lambda *= 4;
            if (lambda > 1e8) break;
        }
    }

    return pose;
}

/** The coplanar subset the homography needs: the pontoons, i.e. the largest group. */
function coplanarSubset(pairs: Pair[]): Pair[] {
    const groups = new Map<string, Pair[]>();
    for (const pair of pairs) {
        const key = (Math.round(pair.point3d.y / PLANE_TOLERANCE) * PLANE_TOLERANCE).toFixed(3);
        const bucket = groups.get(key);
        if (bucket) bucket.push(pair);
        else groups.set(key, [pair]);
    }
    let best: Pair[] = [];
    for (const bucket of groups.values()) {
        if (bucket.length > best.length) best = bucket;
    }
    return best.length >= MIN_PAIRS_FOR_PLANE ? best : [];
}

/**
 * Solves the camera pose from 2D↔3D correspondences.
 *
 * Returns null when there is not enough information (fewer than four pairs, a
 * degenerate configuration, or no candidate with a sane reprojection error).
 * The caller must treat null as "keep the previous pose", never as "identity".
 */
export function solvePnP(
    points3d: readonly Point3[],
    points2d: readonly [number, number][],
    K: Intrinsics,
    options: SolveOptions = {}
): Pose | null {
    const pairs: Pair[] = [];
    for (let i = 0; i < Math.min(points3d.length, points2d.length); i += 1) {
        const [u, v] = points2d[i];
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        pairs.push({ point3d: points3d[i], u, v });
    }
    if (pairs.length < MIN_PAIRS) return null;

    const maxError = options.maxReprojectionError ?? 12;
    let best: Pose | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    const consider = (candidate: Pose) => {
        if (!candidate.rvec.every(Number.isFinite) || !candidate.tvec.every(Number.isFinite)) return;
        const score = scorePose(candidate, pairs, K);
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    };

    // Seed: the previous frame when available (cheapest and most stable), plus
    // the closed-form homography solution.
    if (options.previousPose) consider(options.previousPose);
    for (const candidate of poseFromHomography(coplanarSubset(pairs), K)) consider(candidate);

    if (!best) return null;

    let refined = refine(pairs, K, best, options);

    /**
     * Robust pass: Huber down-weights an outlier, but a 60 px error still pulls
     * the pose a few centimetres. Re-fitting with only the inliers — the cheap,
     * deterministic equivalent of the RANSAC the Python solver used — removes it
     * completely. Iterated because dropping one point can change who else is an
     * outlier.
     */
    for (let pass = 0; pass < 3; pass += 1) {
        const { errors } = reprojectionErrors(refined, pairs, K);
        const survivors = pairs.filter((_pair, index) => errors[index] <= maxError);
        if (survivors.length === pairs.length || survivors.length < MIN_PAIRS_FOR_PLANE) break;
        refined = refine(survivors, K, refined, options);
    }

    const { errors, rms } = reprojectionErrors(refined, pairs, K);
    const inliers = errors.filter((error) => error <= maxError).length;

    if (inliers < MIN_PAIRS_FOR_PLANE) return null;

    return { ...refined, rmsError: rms, inliers, pairs: pairs.length };
}

/** Keypoints the overlay can draw as a self-check: where the pose thinks each point is. */
export function projectAll(
    points: readonly Point3[],
    pose: Pose,
    K: Intrinsics
): Array<[number, number]> {
    return points.map((point) => projectPoint(point, pose, K));
}

/** Camera position in the object frame (three.js world) — used by the renderer. */
export function cameraPosition(pose: Pose): Vec3 {
    const R = rodriguesToMatrix(pose.rvec);
    // C = −Rᵀ·t
    const Rt: Mat3 = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
    const t = pose.tvec;
    return [
        -(Rt[0] * t[0] + Rt[1] * t[1] + Rt[2] * t[2]),
        -(Rt[3] * t[0] + Rt[4] * t[1] + Rt[5] * t[2]),
        -(Rt[6] * t[0] + Rt[7] * t[1] + Rt[8] * t[2]),
    ];
}

/** Kept for tests and for the alignment diagnostic. */
export const poseMath = { mat3Vec, vec3Dot, vec3Cross, vec3Normalize, mat3Inverse, skew };

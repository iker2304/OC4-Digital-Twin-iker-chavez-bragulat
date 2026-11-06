/**
 * Turns detections into a camera pose, and keeps it stable frame to frame.
 *
 * Kept out of the inference loop so it can be reasoned about (and tested) on its
 * own: the loop only decides *when* to call it.
 */
import * as THREE from 'three';
import type { Detection } from '../../types';
import { KEYPOINTS_SCENE } from './keypoints3d';
import { intrinsicsFromFov, solvePnP, type Intrinsics, type Pose } from './solvePnP';
import { rodriguesToMatrix } from './linalg';

export interface PoseTrackerOptions {
    /** Minimum keypoint confidence, as in the original pipeline (0.5). */
    minScore?: number;
    /** Field of view of the longest image side, in degrees. */
    horizontalFovDeg?: number;
    /** Inlier threshold in pixels. */
    maxReprojectionError?: number;
    /** Milliseconds since the last accepted pose. */
    poseAgeMs?: number;
    /** Interval between frames, so a sparse loop may accept bigger jumps. */
    frameMs?: number;
    /**
     * Reject implausible jumps (default `true`).
     *
     * Turning it off shows every solved pose as is. With a fast-moving subject
     * and a slow detector that is what removes the "catching up" effect: the
     * guard is the reason the overlay holds a stale pose while the real one is
     * already available.
     */
    jumpGuard?: boolean;
}

/**
 * A detection is usable for pose estimation when it carries keypoints, and the
 * model must agree with the 11 that have known 3D coordinates.
 */
export function pickPoseDetection(
    detections: Detection[],
    minScore: number
): { detection: Detection; matched: number } | null {
    let best: { detection: Detection; matched: number; mean: number } | null = null;

    for (const detection of detections) {
        const keypoints = detection.keypoints;
        if (!keypoints || keypoints.length < KEYPOINTS_SCENE.length) continue;

        let matched = 0;
        let sum = 0;
        for (let i = 0; i < KEYPOINTS_SCENE.length; i += 1) {
            const score = keypoints[i]?.score ?? 0;
            if (score >= minScore) {
                matched += 1;
                sum += score;
            }
        }
        if (matched === 0) continue;

        const mean = sum / matched;
        if (!best || matched > best.matched || (matched === best.matched && mean > best.mean)) {
            best = { detection, matched, mean };
        }
    }

    return best ? { detection: best.detection, matched: best.matched } : null;
}

/**
 * 2D↔3D correspondences for the solver.
 *
 * A keypoint below the confidence threshold is dropped rather than passed along
 * with a made-up position: `solvePnP` handles a missing point, it cannot handle
 * a wrong one.
 */
export function correspondences(
    detection: Detection,
    minScore: number
): Array<{ point3d: (typeof KEYPOINTS_SCENE)[number]; uv: [number, number] }> {
    const out: Array<{ point3d: (typeof KEYPOINTS_SCENE)[number]; uv: [number, number] }> = [];
    const keypoints = detection.keypoints ?? [];

    for (let i = 0; i < KEYPOINTS_SCENE.length; i += 1) {
        const keypoint = keypoints[i];
        if (!keypoint || keypoint.score < minScore) continue;
        if (!Number.isFinite(keypoint.x) || !Number.isFinite(keypoint.y)) continue;
        out.push({ point3d: KEYPOINTS_SCENE[i], uv: [keypoint.x, keypoint.y] });
    }
    return out;
}

/** Smoothing weight of a new measurement. Lower = steadier but laggier. */
// Sin mezcla: ver `smoothPose`. Se conserva solo por si hay que volver atrás.

/** Rejected as a jump: the camera cannot teleport between frames. */
const MAX_POSITION_JUMP_M = 0.6;
const MAX_ROTATION_JUMP_DEG = 35;

/**
 * After this long without an accepted pose, the tracker stops trusting it.
 *
 * Without this the filter can lock forever: the previous pose is used both as
 * the solver's seed and as the yardstick for the jump check, so once it is wrong
 * every new solution looks like a jump and gets rejected, while a bad seed keeps
 * the solver in the wrong basin. The scene then stays frozen no matter what the
 * camera or the model do.
 */
const REACQUIRE_AFTER_MS = 900;

/** A pose whose fit is worse than this is noise wearing a pose's clothes. */
const MAX_ACCEPTED_RMS_PX = 25;

/** Sane distance from the scene origin, in model units (the platform is ~1 m). */
const MIN_DISTANCE_M = 0.25;
const MAX_DISTANCE_M = 40;

/**
 * Cheap sanity check on a solved pose.
 *
 * A pose that puts the camera a few centimetres from the platform, or 100 m
 * away, or that fits the keypoints terribly, produces an overlay that is either
 * invisible or absurd — and, worse, it becomes the seed for every following
 * frame. Rejecting it is the difference between one bad frame and a stuck app.
 */
export function plausiblePose(pose: Pose): boolean {
    if (!pose.rvec.every(Number.isFinite) || !pose.tvec.every(Number.isFinite)) return false;
    if (!(pose.rmsError <= MAX_ACCEPTED_RMS_PX)) return false;
    const distance = Math.hypot(pose.tvec[0], pose.tvec[1], pose.tvec[2]);
    return distance >= MIN_DISTANCE_M && distance <= MAX_DISTANCE_M;
}

function toQuaternion(rvec: [number, number, number]): THREE.Quaternion {
    const R = rodriguesToMatrix(rvec);
    return new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1)
    );
}


function cameraPositionOf(pose: Pose): THREE.Vector3 {
    const R = rodriguesToMatrix(pose.rvec);
    const t = pose.tvec;
    return new THREE.Vector3(
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])
    );
}

/**
 * Blends a new pose into the previous one.
 *
 * Rotation is interpolated as a quaternion (a linear blend of rotation vectors
 * swings through nonsense when the angle is large) and the result is rejected
 * when it implies a jump no real camera could make — a spurious pose is worse
 * than a stale one, because it makes the whole scene lurch.
 *
 * Two ways out of that guard: the allowed jump grows with the frame interval (at
 * 5 fps the camera really does travel much further between frames than at 30),
 * and a measurement that fits twice as well as what is on screen wins outright,
 * because the pose being displayed is then demonstrably the wrong one.
 */
export function smoothPose(previous: Pose | null, measured: Pose, frameMs = 66, guard = true): Pose {
    if (!previous) return measured;
    if (!guard) return measured;
    if (measured.rmsError * 2 <= previous.rmsError) return measured;

    const stretch = Math.min(3, Math.max(1, frameMs / 66));

    if (
        toQuaternion(previous.rvec).angleTo(toQuaternion(measured.rvec)) >
        (MAX_ROTATION_JUMP_DEG * stretch * Math.PI) / 180
    ) {
        return previous;
    }
    if (cameraPositionOf(previous).distanceTo(cameraPositionOf(measured)) > MAX_POSITION_JUMP_M * stretch) {
        return previous;
    }

    /**
     * Within the allowance the measurement is taken **as is**.
     *
     * This used to blend at 35 % per measurement, which is a first-order lag: the
     * twin trails the real platform and then catches up, and that reads exactly
     * like inertia — the overlay "slides" out of place whenever the camera moves.
     * The guard against absurd jumps stays (that is what the checks above do);
     * smoothing the *plausible* ones only ever adds lag.
     */
    return measured;
}

/**
 * Whether the twin should be drawn at all.
 *
 * In pose mode the twin is a replica *of something specific*: an overlay left
 * behind when that something is not on screen is not just useless, it actively
 * lies — it claims the platform is where the phone is pointing. So it is hidden
 * while nothing is detected, and again when the pose has gone stale for long
 * enough that the solver is clearly not following anything.
 *
 * `graceMs` exists because detections flicker: `YOLO` misses a frame here and
 * there, and the twin blinking at 10 Hz looks like a bug rather than feedback.
 */
export function shouldShowTwin(params: {
    poseEnabled: boolean;
    detections: number;
    /** How long ago the last accepted pose was solved. */
    poseAgeMs: number;
    /** How long ago a bounding box was last seen. */
    sinceDetectionMs: number;
    graceMs?: number;
    staleMs?: number;
}): boolean {
    // Free-look mode: there is no detection to depend on, the twin is the subject.
    if (!params.poseEnabled) return true;
    // Never detected anything: nothing to stand on.
    if (!Number.isFinite(params.poseAgeMs)) return false;
    if (params.detections === 0 && params.sinceDetectionMs > (params.graceMs ?? TWIN_GRACE_MS)) {
        return false;
    }
    return params.poseAgeMs <= (params.staleMs ?? TWIN_STALE_MS);
}

/** Detections flicker; a quarter of a second is enough to tell a miss from a loss. */
const TWIN_GRACE_MS = 250;
/** Long enough to be a real stall, short enough not to keep a wrong twin alive. */
const TWIN_STALE_MS = 2500;

/**
 * One pose-estimation step.
 *
 * Returns the smoothed pose, the previous one while the frame carries no usable
 * information, or `null` when even that has to be dropped (nothing has been
 * solved yet, or what was being displayed is itself implausible).
 *
 * `reacquired` marks the frames where the tracker deliberately forgot its
 * history: the caller shows that state, and it is the signal that the overlay
 * has been re-locked instead of silently drifting.
 */
export function updatePose(params: {
    detections: Detection[];
    sourceWidth: number;
    sourceHeight: number;
    previous: Pose | null;
    options?: PoseTrackerOptions;
}): {
    pose: Pose | null;
    intrinsics: Intrinsics | null;
    matched: number;
    solved: boolean;
    /**
     * Whether the *measurement* made it onto the screen.
     *
     * `solved` says the solver produced a pose; `accepted` says it was the one
     * used. They differ on exactly the frames that matter: when the jump guard
     * rejects every measurement, `solved` stays `true` while the pose on screen
     * never changes. Callers must age the tracker by `accepted`, not by `solved`
     * — otherwise `REACQUIRE_AFTER_MS` never elapses and the overlay locks up for
     * good (the bug that made the twin freeze until the live view was reopened).
     */
    accepted: boolean;
    reacquired: boolean;
} {
    const { detections, sourceWidth, sourceHeight, previous } = params;
    const minScore = params.options?.minScore ?? 0.5;
    const fov = params.options?.horizontalFovDeg ?? 68;
    const frameMs = params.options?.frameMs ?? 66;
    const ageMs = params.options?.poseAgeMs ?? Number.POSITIVE_INFINITY;

    // A stale pose is worse than no pose: it steers the solver and blocks the
    // jump check at the same time.
    const reacquire = !previous || !plausiblePose(previous) || ageMs > REACQUIRE_AFTER_MS;
    const fallback = previous && plausiblePose(previous) ? previous : null;

    if (sourceWidth <= 0 || sourceHeight <= 0) {
        return {
            pose: fallback,
            intrinsics: null,
            matched: 0,
            solved: false,
            accepted: false,
            reacquired: false,
        };
    }

    const intrinsics = intrinsicsFromFov(sourceWidth, sourceHeight, fov);
    const picked = pickPoseDetection(detections, minScore);
    if (!picked) {
        return { pose: fallback, intrinsics, matched: 0, solved: false, accepted: false, reacquired: false };
    }

    const pairs = correspondences(picked.detection, minScore);
    const solved = solvePnP(
        pairs.map((pair) => pair.point3d),
        pairs.map((pair) => pair.uv),
        intrinsics,
        {
            // Forgetting the seed is what lets the solver escape a wrong basin.
            previousPose: reacquire ? null : previous,
            maxReprojectionError: reacquire ? 20 : params.options?.maxReprojectionError ?? 12,
        }
    );

    if (!solved || !plausiblePose(solved)) {
        return {
            pose: fallback,
            intrinsics,
            matched: picked.matched,
            solved: false,
            accepted: false,
            reacquired: false,
        };
    }

    if (reacquire) {
        return { pose: solved, intrinsics, matched: picked.matched, solved: true, accepted: true, reacquired: true };
    }

    const smoothed = smoothPose(previous, solved, frameMs, params.options?.jumpGuard ?? true);
    return {
        pose: smoothed,
        intrinsics,
        matched: picked.matched,
        solved: true,
        // `smoothPose` hands back the previous pose when the measurement implies a
        // jump, and the measurement itself when it does not — identity tells them
        // apart without a second comparison.
        accepted: smoothed === solved,
        reacquired: false,
    };
}

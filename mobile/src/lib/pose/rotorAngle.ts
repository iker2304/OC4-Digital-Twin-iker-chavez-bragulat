/**
 * Blade azimuth of the rotor, measured from the image.
 *
 * ## Why this is a separate solve
 *
 * The base pose is one rigid transform solved from 11 points on the pontoons and
 * the tower base (`solvePnP`). Everything the camera can see is fixed by it
 * **except one number**: how far the rotor has turned. The only rotor landmark
 * in the `WindTurbine` class is the hub, and a point says where the hub is, not
 * where the blades point — which is why the twin used to draw the blades at
 * whatever angle the GLB was exported with.
 *
 * The model does emit blade keypoints for its `Rotor` class (two per blade), so
 * the missing number can simply be *fitted*: rotate the three blade segments
 * about the hub for a candidate angle, project them, and keep the angle whose
 * segments pass through the detected blade points.
 *
 * A second 6-DoF PnP would be the wrong tool here: the rotor has exactly one
 * degree of freedom (rotation about its own axis, which the base pose already
 * places in space), so six unknowns fitted to six nearly collinear points would
 * wander — tilting the rotor instead of turning it.
 *
 * Geometry from `OC4.glb` (`node scripts/count-blades.mjs`): hub at
 * (0.001, 1.145, −0.258), blades at 90°, 210° and 330° in the model's XY plane,
 * root at r≈0.21 m and tip at r=0.63 m, spin axis +Z.
 */
import { projectPoint } from './solvePnP';
import type { Intrinsics, Pose } from './solvePnP';
import type { Point3 } from './keypoints3d';
import type { Detection, Keypoint } from '../../types';

/** Hub position in the model frame (metres). */
export const ROTOR_HUB: Point3 = { x: 0.0009, y: 1.145, z: -0.2576 };
/**
 * Blade azimuths in the exported pose, degrees in the model's XY plane, **in the
 * same order as the keypoint slots** (red, blue, yellow).
 *
 * The blades are identical in shape but not in colour, so the 120° ambiguity is
 * real and has to be resolved by colour: in `OC4.glb` the red blade sits at 330°,
 * the blue one at 90° and the yellow one at 210°. With this order the fit returns
 * ~349° on the reference photo, which is exactly the angle that makes the blades
 * line up by eye (+120° from what the previous order gave).
 */
export const BLADE_AZIMUTHS_DEG = [330, 90, 210];
/** Radial extent of a blade, from the hub. */
const BLADE_ROOT_R = 0.21;
const BLADE_TIP_R = 0.63;
/**
 * Keypoints of the `Rotor` class that carry blade points: slots 0-1 red,
 * 3-4 blue, 6-7 yellow (9 keypoints defined, 8-10 padded and never detected).
 */
const BLADE_SLOTS = [0, 1, 3, 4, 6, 7];
/** Points further than this from their blade segment are treated as outliers. */
const OUTLIER_PX = 90;
const COARSE_STEP_DEG = 3;
const FINE_STEP_DEG = 0.25;
/** A fit worse than this is not trusted (blades hidden, detection garbage). */
const MAX_RMS_PX = 45;

export interface RotorSolution {
    /** Rotor angle that best explains the detected blade points. */
    angleDeg: number;
    /** RMS distance from each blade point to its projected blade segment. */
    rmsPx: number;
    points: number;
}

function bladePoint(azimuthDeg: number, radius: number): Point3 {
    const radians = (azimuthDeg * Math.PI) / 180;
    return {
        x: ROTOR_HUB.x + Math.cos(radians) * radius,
        y: ROTOR_HUB.y + Math.sin(radians) * radius,
        z: ROTOR_HUB.z,
    };
}

/** Squared distance from a point to a segment, in pixels. */
function segmentDistanceSq(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

interface Observation {
    /** Index into `BLADE_AZIMUTHS_DEG`. */
    blade: number;
    x: number;
    y: number;
}

/** Blade points of a `Rotor` detection, grouped by blade. */
function observationsFrom(keypoints: Keypoint[], minScore: number): Observation[] {
    const observations: Observation[] = [];
    for (const slot of BLADE_SLOTS) {
        const keypoint = keypoints[slot];
        if (!keypoint || keypoint.score < minScore) continue;
        if (!Number.isFinite(keypoint.x) || !Number.isFinite(keypoint.y)) continue;
        // Slots 0-2 are the red blade, 3-5 the blue one, 6-8 the yellow one. The
        // three blades are identical and 120° apart, so which physical blade is
        // which does not change the *rendered* result: a wrong assignment is
        // absorbed as a 120° offset, and the rotor looks the same.
        observations.push({ blade: Math.floor(slot / 3) % BLADE_AZIMUTHS_DEG.length, x: keypoint.x, y: keypoint.y });
    }
    return observations;
}

/**
 * Picks the `Rotor` detection that carries the most usable blade points.
 *
 * `excludeClassId` is essential: the platform class also has points in these
 * slots (they are its own 11 keypoints), so without it the "blade" points are
 * the pontoon ones and the fit is nonsense.
 */
export function pickRotorDetection(
    detections: Detection[],
    minScore: number,
    excludeClassId: number | null = null
): { detection: Detection; points: number } | null {
    let best: { detection: Detection; points: number } | null = null;
    for (const detection of detections) {
        if (excludeClassId !== null && detection.classId === excludeClassId) continue;
        if (!detection.keypoints || detection.keypoints.length < 8) continue;
        const observations = observationsFrom(detection.keypoints, minScore);
        if (observations.length < 3) continue;
        if (!best || observations.length > best.points) {
            best = { detection, points: observations.length };
        }
    }
    return best;
}

function scoreAngle(
    angleDeg: number,
    observations: Observation[],
    pose: Pose,
    K: Intrinsics
): { cost: number; count: number } {
    let cost = 0;
    let count = 0;
    for (const observation of observations) {
        const azimuth = BLADE_AZIMUTHS_DEG[observation.blade] + angleDeg;
        const root = projectPoint(bladePoint(azimuth, BLADE_ROOT_R), pose, K);
        const tip = projectPoint(bladePoint(azimuth, BLADE_TIP_R), pose, K);
        if (!Number.isFinite(root[0]) || !Number.isFinite(tip[0])) continue;
        const distanceSq = segmentDistanceSq(observation.x, observation.y, root[0], root[1], tip[0], tip[1]);
        cost += Math.min(distanceSq, OUTLIER_PX * OUTLIER_PX);
        count += 1;
    }
    return { cost, count };
}

/**
 * Fits the rotor angle. Returns `null` when there is nothing reliable to fit.
 *
 * `previousDeg` only seeds the search: the coarse sweep covers the full circle,
 * so the fit never gets stuck in a local minimum because of it.
 */
export function fitRotorAngle(
    pose: Pose,
    K: Intrinsics,
    keypoints: Keypoint[],
    minScore: number
): RotorSolution | null {
    const observations = observationsFrom(keypoints, minScore);
    if (observations.length < 3) return null;

    let bestAngle = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let angle = 0; angle < 360; angle += COARSE_STEP_DEG) {
        const { cost, count } = scoreAngle(angle, observations, pose, K);
        if (count === 0) continue;
        const mean = cost / count;
        if (mean < bestCost) {
            bestCost = mean;
            bestAngle = angle;
        }
    }
    if (!Number.isFinite(bestCost)) return null;

    // Refine around the winner. The cost is smooth in the angle, so a small
    // bracket is enough and keeps the whole fit well under a millisecond.
    for (let angle = bestAngle - COARSE_STEP_DEG; angle <= bestAngle + COARSE_STEP_DEG; angle += FINE_STEP_DEG) {
        const { cost, count } = scoreAngle(angle, observations, pose, K);
        if (count === 0) continue;
        const mean = cost / count;
        if (mean < bestCost) {
            bestCost = mean;
            bestAngle = angle;
        }
    }

    const rmsPx = Math.sqrt(bestCost);
    if (rmsPx > MAX_RMS_PX) return null;
    return {
        angleDeg: ((bestAngle % 360) + 360) % 360,
        rmsPx,
        points: observations.length,
    };
}

/** RMS blade-point error for one specific angle (used by the verifiers). */
export function rotorRmsAt(
    angleDeg: number,
    pose: Pose,
    K: Intrinsics,
    keypoints: Keypoint[],
    minScore: number
): number | null {
    const observations = observationsFrom(keypoints, minScore);
    if (observations.length === 0) return null;
    const { cost, count } = scoreAngle(angleDeg, observations, pose, K);
    if (count === 0) return null;
    return Math.sqrt(cost / count);
}

/** Per-observation dump, for the verifiers and for wiring problems. */
export function rotorDetail(
    angleDeg: number,
    pose: Pose,
    K: Intrinsics,
    keypoints: Keypoint[],
    minScore: number
): string[] {
    return observationsFrom(keypoints, minScore).map((observation) => {
        const azimuth = BLADE_AZIMUTHS_DEG[observation.blade] + angleDeg;
        const root = projectPoint(bladePoint(azimuth, BLADE_ROOT_R), pose, K);
        const tip = projectPoint(bladePoint(azimuth, BLADE_TIP_R), pose, K);
        const distance = Math.sqrt(
            segmentDistanceSq(observation.x, observation.y, root[0], root[1], tip[0], tip[1])
        );
        return (
            `pala${observation.blade} obs(${observation.x.toFixed(0)}, ${observation.y.toFixed(0)}) ` +
            `seg (${root[0].toFixed(0)}, ${root[1].toFixed(0)})-(${tip[0].toFixed(0)}, ${tip[1].toFixed(0)}) ` +
            `d=${distance.toFixed(0)} px`
        );
    });
}

/** Shortest signed difference between two angles, in degrees. */
export function angleDeltaDeg(fromDeg: number, toDeg: number): number {
    let delta = ((toDeg - fromDeg) % 360 + 540) % 360 - 180;
    if (Math.abs(delta) > 180) delta -= Math.sign(delta) * 360;
    return delta;
}

/** Exponential smoothing that wraps correctly across 0°/360°. */
export function smoothAngleDeg(previousDeg: number | null, nextDeg: number, alpha: number): number {
    if (previousDeg === null) return nextDeg;
    const value = previousDeg + angleDeltaDeg(previousDeg, nextDeg) * alpha;
    return ((value % 360) + 360) % 360;
}

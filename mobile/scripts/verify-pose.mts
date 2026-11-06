/**
 * Self-test for the PnP solver and the pose→camera conversion.
 *
 *   npm run verify:pose
 *
 * The whole point of the branch's overlay is that the twin lands where the real
 * platform is. That rests on two pieces of maths that are easy to get "almost
 * right" and impossible to debug on a phone, so both are checked here against
 * synthetic projections with a known answer:
 *
 *   1. `solvePnP` recovers the pose that generated the projections.
 *   2. A three.js camera configured by `applyPoseToCamera` reprojects the 3D
 *      points onto the very same pixels (this is the render half).
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { KEYPOINTS_SCENE, PONTOON_PLANE_Y } from '../src/lib/pose/keypoints3d';
import {
    intrinsicsFromFov,
    projectPoint,
    solvePnP,
    type Intrinsics,
    type Pose,
} from '../src/lib/pose/solvePnP';
import { applyPoseToCamera, cameraPosition } from '../src/lib/pose/cameraRig';
import { matrixToRodrigues, rodriguesToMatrix } from '../src/lib/pose/linalg';
import { plausiblePose, shouldShowTwin, smoothPose, updatePose } from '../src/lib/pose/poseTracker';
import { lightVectorModelSpace } from '../src/lib/light/lightDirection';
import { estimateSunDirection } from '../src/lib/light/sunDirection';
import { ModalTracker } from '../src/lib/oma/modalTracker';
import { KeypointKalman } from '../src/lib/pose/keypointKalman';
import {
    BLADE_AZIMUTHS_DEG,
    ROTOR_HUB,
    angleDeltaDeg,
    fitRotorAngle,
    pickRotorDetection,
    rotorRmsAt,
    smoothAngleDeg,
} from '../src/lib/pose/rotorAngle';

let checks = 0;
function check(name: string, fn: () => void) {
    fn();
    checks += 1;
    console.log(`  ok  ${name}`);
}

const WIDTH = 1280;
const HEIGHT = 720;
const K: Intrinsics = intrinsicsFromFov(WIDTH, HEIGHT, 68);

/** A plausible capture: ~1.2 m away, slightly above and to the side. */
const TRUE_POSE: Pose = {
    rvec: [0.22, 0.55, 0.06],
    tvec: [0.06, 0.12, 1.25],
    rmsError: 0,
    inliers: 0,
    pairs: 0,
};

function projectAll(pose: Pose): Array<[number, number]> {
    return KEYPOINTS_SCENE.map((point) => projectPoint(point, pose, K));
}

function positionError(a: Pose, b: Pose): number {
    const pa = cameraPosition(a);
    const pb = cameraPosition(b);
    return pa.distanceTo(pb);
}

function rotationErrorDeg(a: Pose, b: Pose): number {
    const qa = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().set(...rodriguesRowMajor(a.rvec))
    );
    const qb = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().set(...rodriguesRowMajor(b.rvec))
    );
    return (qa.angleTo(qb) * 180) / Math.PI;
}

function rodriguesRowMajor(rvec: [number, number, number]): number[] {
    const R = rodriguesToMatrix(rvec);
    return [R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1];
}

function addNoise(points: Array<[number, number]>, amplitude: number, seed = 1): Array<[number, number]> {
    // Deterministic pseudo-random so a failure is reproducible.
    let state = seed;
    const next = () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648 - 0.5;
    };
    return points.map(([u, v]) => [u + next() * 2 * amplitude, v + next() * 2 * amplitude]);
}

/* --------------------------------------------------------------- intrinsics */

console.log('intrinsics');

check('FOV → focal length is the pinhole relation', () => {
    const fov = (68 * Math.PI) / 180;
    assert.ok(Math.abs(K.fx - WIDTH / 2 / Math.tan(fov / 2)) < 1e-9);
    assert.equal(K.cx, WIDTH / 2);
    assert.equal(K.cy, HEIGHT / 2);
});

check('a wider lens has a shorter focal length', () => {
    assert.ok(intrinsicsFromFov(WIDTH, HEIGHT, 90).fx < intrinsicsFromFov(WIDTH, HEIGHT, 60).fx);
});

/* ---------------------------------------------------------------- solver */

console.log('solvePnP');

check('the 11 keypoints do have a coplanar group (the pontoons)', () => {
    const onPlane = KEYPOINTS_SCENE.filter((p) => Math.abs(p.y - PONTOON_PLANE_Y) < 0.02);
    assert.equal(onPlane.length, 9);
});

check('exact projections: pose is recovered', () => {
    const solved = solvePnP(KEYPOINTS_SCENE, projectAll(TRUE_POSE), K);
    assert.ok(solved, 'expected a pose');
    assert.ok(positionError(solved, TRUE_POSE) < 1e-3, `position error ${positionError(solved, TRUE_POSE)}`);
    assert.ok(rotationErrorDeg(solved, TRUE_POSE) < 0.5, `rotation error ${rotationErrorDeg(solved, TRUE_POSE)}`);
    assert.ok(solved.rmsError < 0.01, `rms ${solved.rmsError}`);
    assert.equal(solved.inliers, 11);
});

check('with 0.7 px of noise the pose stays within a centimetre and one degree', () => {
    const solved = solvePnP(KEYPOINTS_SCENE, addNoise(projectAll(TRUE_POSE), 0.7), K);
    assert.ok(solved);
    assert.ok(positionError(solved, TRUE_POSE) < 0.01, `position error ${positionError(solved, TRUE_POSE)}`);
    assert.ok(rotationErrorDeg(solved, TRUE_POSE) < 1, `rotation error ${rotationErrorDeg(solved, TRUE_POSE)}`);
});

check('a grossly wrong keypoint is rejected, not absorbed', () => {
    const points = projectAll(TRUE_POSE);
    // Hub (index 6) detected 60 px away: it must end up as an outlier.
    points[6] = [points[6][0] + 60, points[6][1] - 45];
    const solved = solvePnP(KEYPOINTS_SCENE, points, K, { maxReprojectionError: 12 });
    assert.ok(solved);
    assert.ok(positionError(solved, TRUE_POSE) < 0.05, `position error ${positionError(solved, TRUE_POSE)}`);
    assert.ok(rotationErrorDeg(solved, TRUE_POSE) < 3, `rotation error ${rotationErrorDeg(solved, TRUE_POSE)}`);
    assert.equal(solved.inliers, 10, `inliers ${solved.inliers}`);
});

check('two bad keypoints out of eleven still leave a usable pose', () => {
    const points = projectAll(TRUE_POSE);
    points[6] = [points[6][0] + 80, points[6][1] + 60];
    points[10] = [points[10][0] - 70, points[10][1] - 50];
    const solved = solvePnP(KEYPOINTS_SCENE, points, K);
    assert.ok(solved);
    assert.ok(positionError(solved, TRUE_POSE) < 0.1, `position error ${positionError(solved, TRUE_POSE)}`);
});

check('the previous pose as a seed gives the same answer', () => {
    const points = projectAll(TRUE_POSE);
    const seeded = solvePnP(KEYPOINTS_SCENE, points, K, { previousPose: { ...TRUE_POSE, rvec: [0.19, 0.5, 0.05] } });
    assert.ok(seeded);
    assert.ok(positionError(seeded, TRUE_POSE) < 1e-3);
});

check('too few points → null, never a fake identity pose', () => {
    assert.equal(solvePnP(KEYPOINTS_SCENE.slice(0, 3), projectAll(TRUE_POSE).slice(0, 3), K), null);
});

/* ------------------------------------------------------- render-side check */

console.log('pose → three.js camera');

check('a three.js camera with the solved pose reprojects onto the detections', () => {
    const detections = projectAll(TRUE_POSE);
    const solved = solvePnP(KEYPOINTS_SCENE, detections, K);
    assert.ok(solved);

    const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 100);
    const applied = applyPoseToCamera(camera, solved, K, {
        width: WIDTH,
        height: HEIGHT,
        sourceWidth: WIDTH,
        sourceHeight: HEIGHT,
    });
    assert.ok(applied);

    for (let i = 0; i < KEYPOINTS_SCENE.length; i += 1) {
        const point = KEYPOINTS_SCENE[i];
        const ndc = new THREE.Vector3(point.x, point.y, point.z).project(camera);
        const u = (ndc.x * 0.5 + 0.5) * WIDTH;
        const v = (1 - (ndc.y * 0.5 + 0.5)) * HEIGHT;
        const error = Math.hypot(u - detections[i][0], v - detections[i][1]);
        assert.ok(error < 1.0, `keypoint ${i} reprojects ${error.toFixed(2)} px away`);
    }
});

check('the same holds when the video is cropped by object-fit: cover', () => {
    // 16:9 video inside a portrait viewport: the sides get cropped away.
    const viewport = { width: 390, height: 500, sourceWidth: WIDTH, sourceHeight: HEIGHT };
    const detections = projectAll(TRUE_POSE);
    const solved = solvePnP(KEYPOINTS_SCENE, detections, K);
    assert.ok(solved);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    assert.ok(applyPoseToCamera(camera, solved, K, viewport));

    // Reproduce the crop the browser applies: scale = max(w/srcW, h/srcH).
    const scale = Math.max(viewport.width / WIDTH, viewport.height / HEIGHT);
    const visibleWidth = viewport.width / scale;
    const visibleHeight = viewport.height / scale;
    const offsetX = (WIDTH - visibleWidth) / 2;
    const offsetY = (HEIGHT - visibleHeight) / 2;

    for (let i = 0; i < KEYPOINTS_SCENE.length; i += 1) {
        const point = KEYPOINTS_SCENE[i];
        const ndc = new THREE.Vector3(point.x, point.y, point.z).project(camera);
        // NDC → display pixels → back to source pixels for comparison.
        const displayX = (ndc.x * 0.5 + 0.5) * viewport.width;
        const displayY = (1 - (ndc.y * 0.5 + 0.5)) * viewport.height;
        const sourceX = displayX / scale + offsetX;
        const sourceY = displayY / scale + offsetY;
        const error = Math.hypot(sourceX - detections[i][0], sourceY - detections[i][1]);
        assert.ok(error < 1.5, `keypoint ${i} reprojects ${error.toFixed(2)} px away`);
    }
});

check('Rodrigues round-trips', () => {
    for (const rvec of [[0, 0, 0], [0.3, -0.7, 1.2], [1e-9, 0, 0]] as Array<[number, number, number]>) {
        const back = matrixToRodrigues(rodriguesToMatrix(rvec));
        const error = Math.hypot(back[0] - rvec[0], back[1] - rvec[1], back[2] - rvec[2]);
        assert.ok(error < 1e-6, `round-trip error ${error}`);
    }
});

/* ------------------------------------------------------- tracker behaviour */

/** A detection carrying the projected keypoints of `pose`. */
function detectionFrom(pose: Pose, shift: [number, number] = [0, 0]) {
    const points = projectAll(pose);
    return {
        id: 1,
        classId: 0,
        label: 'WindTurbine',
        score: 0.9,
        bbox: [0, 0, WIDTH, HEIGHT] as [number, number, number, number],
        keypoints: points.map(([x, y]) => ({ x: x + shift[0], y: y + shift[1], score: 0.95 })),
    };
}

check('a plausible pose is accepted, an absurd one is not', () => {
    assert.equal(plausiblePose(TRUE_POSE), true);
    // Camera 3 cm from the platform: the twin would swallow the whole view.
    assert.equal(plausiblePose({ ...TRUE_POSE, tvec: [0.01, 0.02, 0.03] }), false);
    // Camera 300 m away: nothing to see.
    assert.equal(plausiblePose({ ...TRUE_POSE, tvec: [0, 0, 300] }), false);
    // A fit that bad is noise, not a pose.
    assert.equal(plausiblePose({ ...TRUE_POSE, rmsError: 40 }), false);
});

check('a locked tracker forgets its history instead of freezing forever', () => {
    // What the app had before: a wrong pose that also blocks the jump check.
    const wrong: Pose = { ...TRUE_POSE, tvec: [-0.4, 0.1, 3.4], rvec: [0.5, -0.9, 0.1] };
    const detection = detectionFrom(TRUE_POSE);

    const stuck = updatePose({
        detections: [detection],
        sourceWidth: WIDTH,
        sourceHeight: HEIGHT,
        previous: wrong,
        options: { minScore: 0.4, horizontalFovDeg: 68, poseAgeMs: 0 },
    });
    // Fresh but wrong: the jump guard keeps it (that is the point of the guard).
    assert.ok(stuck.pose, 'keeps the previous pose');
    assert.ok(
        positionError(stuck.pose as Pose, TRUE_POSE) > 1,
        'and it is indeed the wrong one'
    );

    // Same situation, but the pose on screen is old: now it must re-lock.
    const recovered = updatePose({
        detections: [detection],
        sourceWidth: WIDTH,
        sourceHeight: HEIGHT,
        previous: wrong,
        options: { minScore: 0.4, horizontalFovDeg: 68, poseAgeMs: 5000 },
    });
    assert.equal(recovered.solved, true, 'solves');
    assert.equal(recovered.reacquired, true, 'and says so');
    assert.ok(
        positionError(recovered.pose as Pose, TRUE_POSE) < 0.05,
        'landing on the real pose'
    );
});

check('a measurement that fits twice as well overrides the jump guard', () => {
    const stale: Pose = { ...TRUE_POSE, tvec: [-0.4, 0.1, 3.4], rmsError: 12 };
    const better: Pose = { ...TRUE_POSE, rmsError: 2 };
    const smoothed = smoothPose(stale, better, 66);
    assert.ok(positionError(smoothed, better) < 1e-6, 'the better fit is taken as-is');
});

check('a rejected measurement still counts as solved, but not as accepted', () => {
    // This is the distinction the freeze depended on: the solver produces a pose
    // (solved) that the jump guard throws away (not accepted).
    const wrong: Pose = { ...TRUE_POSE, tvec: [-0.4, 0.1, 3.4], rvec: [0.5, -0.9, 0.1] };
    const rejected = updatePose({
        detections: [detectionFrom(TRUE_POSE)],
        sourceWidth: WIDTH,
        sourceHeight: HEIGHT,
        previous: wrong,
        options: { minScore: 0.4, horizontalFovDeg: 68, poseAgeMs: 0, frameMs: 100 },
    });
    assert.equal(rejected.solved, true, 'the solver did solve');
    assert.equal(rejected.accepted, false, 'but nothing was shown for it');

    const accepted = updatePose({
        detections: [detectionFrom(TRUE_POSE)],
        sourceWidth: WIDTH,
        sourceHeight: HEIGHT,
        previous: null,
        options: { minScore: 0.4, horizontalFovDeg: 68 },
    });
    assert.equal(accepted.accepted, true, 'a fresh solve is accepted');
});

check('a tracker whose measurements are all rejected re-locks on its own', () => {
    /**
     * Reproduces the live loop: the clock has to advance on *accepted* poses only.
     * With the old code the loop refreshed the timestamp on every solve, the age
     * never reached the re-acquire threshold, and the overlay stayed frozen until
     * the live view was reopened.
     */
    const wrong: Pose = { ...TRUE_POSE, tvec: [-0.4, 0.1, 3.4], rvec: [0.5, -0.9, 0.1] };
    let acceptedAt = 0;
    let pose: Pose | null = wrong;
    let reacquiredAfter = -1;

    // 20 frames of 100 ms — two seconds of video at the phone's real rate.
    for (let frame = 0; frame < 20; frame += 1) {
        const nowMs = frame * 100;
        const tracked = updatePose({
            detections: [detectionFrom(TRUE_POSE)],
            sourceWidth: WIDTH,
            sourceHeight: HEIGHT,
            previous: pose,
            options: {
                minScore: 0.4,
                horizontalFovDeg: 68,
                poseAgeMs: acceptedAt === 0 && frame === 0 ? 0 : nowMs - acceptedAt,
                frameMs: 100,
            },
        });
        pose = tracked.pose ?? pose;
        if (tracked.accepted) {
            acceptedAt = nowMs;
            if (reacquiredAfter < 0 && tracked.reacquired) reacquiredAfter = frame;
        }
    }

    assert.ok(reacquiredAfter >= 0, 'it never re-locked');
    assert.ok(reacquiredAfter <= 12, `re-locked after ${reacquiredAfter} frames (should be ~1 s)`);
    assert.ok(positionError(pose as Pose, TRUE_POSE) < 0.05, 'and it landed on the real pose');

    // The same run with the *old* clock (ageing on every solve, accepted or not):
    // it must stay locked, which is the bug this test exists for.
    let solvedAt = 0;
    let stuckPose: Pose | null = wrong;
    let stuckReacquired = false;
    for (let frame = 0; frame < 20; frame += 1) {
        const nowMs = frame * 100;
        const tracked = updatePose({
            detections: [detectionFrom(TRUE_POSE)],
            sourceWidth: WIDTH,
            sourceHeight: HEIGHT,
            previous: stuckPose,
            options: { minScore: 0.4, horizontalFovDeg: 68, poseAgeMs: nowMs - solvedAt, frameMs: 100 },
        });
        stuckPose = tracked.pose ?? stuckPose;
        if (tracked.solved) solvedAt = nowMs;
        if (tracked.reacquired) stuckReacquired = true;
    }
    assert.equal(stuckReacquired, false, 'the old clock never re-locks');
    assert.ok(positionError(stuckPose as Pose, TRUE_POSE) > 1, 'and stays on the wrong pose');
});

check('at 5 fps the guard allows the jump a real camera makes', () => {
    const a: Pose = { ...TRUE_POSE, rmsError: 2 };
    const b: Pose = { ...a, tvec: [0.9, 0.12, 1.25], rmsError: 2.5 };
    // A 0.9 m jump in one frame: impossible at 15 fps, plausible at 5. Smoothing
    // still blends it (that is its job), so the test looks at how far the pose
    // was allowed to travel, not at exact equality.
    assert.ok(positionError(smoothPose(a, b, 66), a) < 1e-9, 'rejected at 66 ms');
    assert.ok(positionError(smoothPose(a, b, 200), a) > 0.25, 'moves at 200 ms');
});

check('the twin hides when there is nothing to stand on', () => {
    const base = { poseEnabled: true, detections: 1, poseAgeMs: 100, sinceDetectionMs: 0 };
    assert.equal(shouldShowTwin(base), true, 'tracking normally');
    // A single missed frame must not blink it away.
    assert.equal(shouldShowTwin({ ...base, detections: 0, sinceDetectionMs: 80 }), true);
    // Sustained loss: hidden, not left frozen in the scene.
    assert.equal(shouldShowTwin({ ...base, detections: 0, sinceDetectionMs: 900 }), false);
    // Boxes present but the solver has not followed them for seconds.
    assert.equal(shouldShowTwin({ ...base, poseAgeMs: 4000 }), false);
    // Nothing has ever been solved.
    assert.equal(
        shouldShowTwin({ ...base, poseAgeMs: Number.POSITIVE_INFINITY }),
        false
    );
    // Free-look mode is not gated by detections at all.
    assert.equal(
        shouldShowTwin({ ...base, poseEnabled: false, detections: 0, sinceDetectionMs: 9999 }),
        true
    );
});

/* --------------------------------------------- kalman between detections */

/** A keypoint set that moves at a constant speed, in source pixels. */
function movingKeypoints(timeMs: number, vx: number, vy: number) {
    return KEYPOINTS_SCENE.map((_point, index) => ({
        x: 100 + index * 20 + vx * (timeMs / 1000),
        y: 200 + index * 10 + vy * (timeMs / 1000),
        score: 0.9,
    }));
}

check('the predictor fills in a constant-velocity motion', () => {
    const filter = new KeypointKalman(KEYPOINTS_SCENE.length);
    for (const time of [0, 800, 1600]) {
        filter.correct(movingKeypoints(time, 60, -20), time);
    }
    const truth = movingKeypoints(2000, 60, -20);
    const predicted = filter.predict(2000);
    const worst = Math.max(
        ...predicted.map((point, index) => Math.hypot(point.x - truth[index].x, point.y - truth[index].y))
    );
    assert.ok(worst < 12, `prediction is ${worst.toFixed(1)} px off`);
});

check('a still target does not drift', () => {
    const filter = new KeypointKalman(KEYPOINTS_SCENE.length);
    for (const time of [0, 800, 1600]) filter.correct(movingKeypoints(time, 0, 0), time);
    const truth = movingKeypoints(1600, 0, 0);
    const predicted = filter.predict(2400);
    const worst = Math.max(
        ...predicted.map((point, index) => Math.hypot(point.x - truth[index].x, point.y - truth[index].y))
    );
    assert.ok(worst < 8, `still target drifts ${worst.toFixed(1)} px`);
});

check('a jump cannot produce an absurd extrapolation', () => {
    const filter = new KeypointKalman(KEYPOINTS_SCENE.length, { maxSpeed: 2000 });
    filter.correct(movingKeypoints(0, 0, 0), 0);
    filter.correct(movingKeypoints(800, 0, 0), 800);
    // Teleport 600 px and predict a second ahead: the speed is capped.
    const jumped = movingKeypoints(1600, 0, 0).map((point) => ({ ...point, x: point.x + 600 }));
    filter.correct(jumped, 1600);
    const predicted = filter.predict(2600);
    const from = movingKeypoints(1600, 0, 0).map((point) => ({ ...point, x: point.x + 600 }));
    const worst = Math.max(...predicted.map((point, index) => Math.abs(point.x - from[index].x)));
    assert.ok(worst <= 2000 * 1 + 5, `extrapolated ${worst.toFixed(0)} px`);
});

check('the filter forgets everything on reset and skips unseen points', () => {
    const filter = new KeypointKalman(KEYPOINTS_SCENE.length);
    filter.correct(movingKeypoints(0, 10, 10), 0);
    assert.equal(filter.ready, true);
    filter.reset();
    assert.equal(filter.ready, false);
    assert.deepEqual(filter.predict(1000), []);

    // A detection with only four confident points marks just those as usable.
    const sparse = movingKeypoints(0, 0, 0).map((point, index) => ({
        ...point,
        score: index < 4 ? 0.9 : 0.01,
    }));
    const partial = new KeypointKalman(KEYPOINTS_SCENE.length);
    partial.correct(sparse, 0, 0.4);
    const predicted = partial.predict(0);
    assert.equal(predicted[0].score, 0.9);
    assert.equal(predicted[5].score, 0);
});

/* ------------------------------------------------------- rotor (blade angle) */

/** Blade keypoints as the `Rotor` class emits them, for a given true angle. */
function bladeKeypoints(angleDeg: number): { x: number; y: number; score: number }[] {
    const slots = new Array(11).fill(null).map(() => ({ x: 0, y: 0, score: 0.01 }));
    const radii = [0.33, 0.60];
    [0, 1, 3, 4, 6, 7].forEach((slot, index) => {
        const blade = Math.floor(slot / 3) % BLADE_AZIMUTHS_DEG.length;
        const radians = ((BLADE_AZIMUTHS_DEG[blade] + angleDeg) * Math.PI) / 180;
        const radius = radii[index % 2];
        const point = {
            x: ROTOR_HUB.x + Math.cos(radians) * radius,
            y: ROTOR_HUB.y + Math.sin(radians) * radius,
            z: ROTOR_HUB.z,
        };
        const [px, py] = projectPoint(point, TRUE_POSE, K);
        slots[slot] = { x: px, y: py, score: 0.95 };
    });
    return slots;
}

check('the rotor angle is recovered from the blade keypoints', () => {
    for (const truth of [0, 47, 180, 300]) {
        const solution = fitRotorAngle(TRUE_POSE, K, bladeKeypoints(truth), 0.4);
        assert.ok(solution, `fits at ${truth}°`);
        const error = Math.abs(angleDeltaDeg(truth, solution.angleDeg));
        assert.ok(error < 4, `expected ~${truth}°, got ${solution.angleDeg.toFixed(1)}°`);
        assert.ok(solution.rmsPx < 3, `rms ${solution.rmsPx.toFixed(1)} px`);
    }
});

check('a wrong angle costs much more than the right one', () => {
    const points = bladeKeypoints(120);
    const solution = fitRotorAngle(TRUE_POSE, K, points, 0.4);
    assert.ok(solution);
    const good = rotorRmsAt(solution.angleDeg, TRUE_POSE, K, points, 0.4);
    const off = rotorRmsAt(solution.angleDeg + 20, TRUE_POSE, K, points, 0.4);
    assert.ok(good !== null && off !== null, 'both angles score');
    assert.ok(
        off > good * 3,
        `20° off must be clearly worse: ${good.toFixed(1)} vs ${off.toFixed(1)} px`
    );
});

check('with fewer than three blade points there is nothing to fit', () => {
    const points = bladeKeypoints(30).map((point) => ({ ...point, score: 0.05 }));
    assert.equal(fitRotorAngle(TRUE_POSE, K, points, 0.4), null);
});

check('the rotor detection ignores the platform class', () => {
    const platform = {
        id: 1,
        classId: 0,
        label: 'WindTurbine',
        score: 0.95,
        bbox: [0, 0, WIDTH, HEIGHT] as [number, number, number, number],
        keypoints: bladeKeypoints(10),
    };
    const rotor = {
        ...platform,
        id: 2,
        classId: 1,
        label: 'Rotor',
        keypoints: bladeKeypoints(200),
    };
    const picked = pickRotorDetection([platform, rotor], 0.4, 0);
    assert.equal(picked?.detection.id, 2, 'the platform class is skipped');
    // Without the exclusion both look equally valid, which is the bug it prevents.
    assert.ok(pickRotorDetection([platform, rotor], 0.4));
});

check('angle smoothing wraps across 0° and never jumps the long way', () => {
    assert.ok(Math.abs(angleDeltaDeg(350, 10) - 20) < 1e-9);
    assert.ok(Math.abs(angleDeltaDeg(10, 350) + 20) < 1e-9);
    const smoothed = smoothAngleDeg(350, 10, 0.5);
    assert.ok(Math.abs(angleDeltaDeg(350, smoothed) - 10) < 1e-9, `got ${smoothed}`);
    assert.equal(smoothAngleDeg(null, 123, 0.5), 123);
});

check('the measured light is rotated into the model frame', () => {
    // With the identity pose the two frames coincide, so the only change is the
    // OpenCV sign convention: elevation up is −y in camera axes.
    const up = lightVectorModelSpace(0, 90, TRUE_POSE);
    assert.ok(Math.abs(Math.hypot(up.x, up.y, up.z) - 1) < 1e-9, 'unit length');

    // A pose that turns the world 90° about Y must turn the light by the same
    // amount: this is what stops the key light from swinging with the camera.
    const rotated: Pose = { ...TRUE_POSE, rvec: [0, Math.PI / 2, 0] };
    const straight = lightVectorModelSpace(0, 0, { ...TRUE_POSE, rvec: [0, 0, 0] });
    const turned = lightVectorModelSpace(0, 0, rotated);
    // The rotation is applied as its transpose, so the direction rotates back.
    assert.ok(Math.abs(straight.z) > 0.9, 'straight ahead is +z in camera axes');
    assert.ok(Math.abs(Math.hypot(turned.x, turned.y, turned.z) - 1) < 1e-9, 'still unit length');
    assert.ok(Math.abs(turned.z) < 1e-6, 'a 90° yaw puts it on the x axis');
});

check('the fast estimator points at a bright blob where it should', () => {
    // 200×100 frame, focal 100 px: a blob at (150, 20) is 26.6° to the right and
    // 16.7° up from where the camera is looking.
    const width = 200;
    const height = 100;
    const intrinsic = { fx: 100, fy: 100, cx: 100, cy: 50 };
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            const inBlob = Math.hypot(x - 150, y - 20) < 4;
            const value = inBlob ? 255 : 60;
            rgba[index] = value;
            rgba[index + 1] = value;
            rgba[index + 2] = value;
            rgba[index + 3] = 255;
        }
    }
    const estimate = estimateSunDirection(rgba, width, height, intrinsic, null);
    assert.ok(estimate, 'hay estimación');
    assert.ok(Math.abs(estimate.azimuthDeg - 26.57) < 4, `azimut ${estimate.azimuthDeg.toFixed(1)}°`);
    assert.ok(Math.abs(estimate.elevationDeg - 16.7) < 4, `elevación ${estimate.elevationDeg.toFixed(1)}°`);
    assert.ok(estimate.confidence > 0.5, `un blob compacto debe dar confianza alta (${estimate.confidence})`);

    // A flat, featureless frame is not a light source: no bright core, no answer.
    const flat = new Uint8ClampedArray(width * height * 4).fill(30);
    assert.equal(estimateSunDirection(flat, width, height, intrinsic, null), null);
});

check('the modal tracker recovers the frequency of a synthetic oscillation', () => {
    // 64 samples at 10 Hz: the FFT resolution is 1/6.4 s ≈ 0.16 Hz, so half a
    // hertz has to come out within a bin or so.
    const tracker = new ModalTracker(2, 64);
    for (let i = 0; i < 64; i += 1) {
        const t = i * 100;
        const value = Math.sin(2 * Math.PI * 0.5 * (t / 1000)) * 3;
        tracker.push(
            [
                { u: value, v: value / 2 },
                { u: value, v: value / 2 },
            ],
            t
        );
    }
    const spectrum = tracker.spectrum();
    assert.ok(spectrum, 'hay espectro con 64 muestras');
    assert.ok(spectrum.peaks.length > 0, 'y al menos un pico');
    assert.ok(
        Math.abs(spectrum.peaks[0].freqHz - 0.5) < 0.2,
        `esperaba ~0.5 Hz, salió ${spectrum.peaks[0].freqHz.toFixed(3)}`
    );
    assert.ok(spectrum.peaks[0].prominence > 3, 'y destacando sobre el ruido');

    // White noise must not produce a dominant peak above the others.
    const noisy = new ModalTracker(2, 64);
    let seed = 7;
    for (let i = 0; i < 64; i += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const value = (seed / 2147483648 - 0.5) * 6;
        noisy.push([{ u: value, v: -value }, { u: value, v: -value }], i * 100);
    }
    const noiseSpectrum = noisy.spectrum();
    assert.ok(noiseSpectrum);
    assert.ok(
        (noiseSpectrum.peaks[0]?.prominence ?? 0) < 4,
        'el ruido no debe parecer un modo'
    );
});

console.log(`\n${checks} checks passed.`);
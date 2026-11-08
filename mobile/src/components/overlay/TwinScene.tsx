/**
 * Digital-twin layer.
 *
 * ## Two ways of looking at the twin
 *
 * **Pose mode (default).** The camera is placed from the PnP solution of the
 * detected keypoints, using the same maths as the original pipeline: the twin
 * lands exactly where the real platform is, and it does *not* move on its own.
 * That is the whole point — the overlay must not have a life of its own.
 *
 * **Free-look mode.** No pose: the gyroscope (or a slow orbit) drives the view
 * so the model can be inspected. The asset is normalised (centred and scaled) so
 * any export looks reasonable, and detection boxes appear as 3D "holograms".
 * In pose mode both the normalisation and the holograms are off: the model has
 * to stay in its native frame and scale, because that is the frame the 3D
 * keypoints live in.
 */
import { Component, Suspense, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Grid, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { TWIN_MODEL_URL } from '../../lib/env';
import { useAppStore } from '../../store/appStore';
import { computeCover, displayToNdc, sourceToDisplay } from '../../lib/geometry';
import { applyPoseToCamera } from '../../lib/pose/cameraRig';
import { intrinsicsFromFov } from '../../lib/pose/solvePnP';
import { shouldShowTwin } from '../../lib/pose/poseTracker';
import { modalTracker } from '../../lib/oma/modalTracker';
import { BladeFem } from './BladeFem';
import { getGyro, getYawReference, hasGyroSignal, shortestAngle } from '../../lib/useDeviceOrientation';

/** Longest edge of the normalised twin, in world units (free-look mode only). */
const TARGET_SIZE = 6;
const MAX_HOLOGRAMS = 16;
const HOLOGRAM_COLORS = [0x38bdf8, 0x22d3ee, 0x34d399, 0xfbbf24, 0xf472b6, 0xa78bfa];
/** Spin axis of the rotor assembly (`rotate` node) in the model's own frame. */
const ROTOR_AXIS = new THREE.Vector3(0, 0, 1);
/**
 * Node names the rotor assembly answers to.
 *
 * The two exports of the same scene do not agree: `OC4.glb` calls it `rotate`
 * and `OC4-modal.glb` calls it `rotation`. Looking only for `rotate` silently
 * turned the blades into decoration — the fit kept running, `rotorAngleAuto`
 * kept updating, and nothing in the GLB moved.
 */
const ROTOR_NODE_NAMES = ['rotate', 'rotation'];

/** Where the camera rests before the first pose is solved (pose mode). */
const IDLE_CAMERA = new THREE.Vector3(0, 0.9, 3.2);
const IDLE_TARGET = new THREE.Vector3(0, 0.45, 0);

/**
 * Key + fill lights.
 *
 * The key light follows the measured scene sunlight when the user has run the
 * lighting estimate, so the twin is lit from the same side as the real machine;
 * otherwise it keeps the studio-ish default. The secondary light stays fixed:
 * a single measured direction plus a fixed fill reads much better than two
 * measured ones.
 */
function SceneLights() {
    const vector = useAppStore((state) => state.lightVector);
    const measured = vector !== null;
    return (
        <>
            <directionalLight
                position={vector ? [vector.x * 8, vector.y * 8, vector.z * 8] : [6, 10, 6]}
                intensity={1.6}
                castShadow={false}
            />
            <directionalLight
                position={measured ? [-vector.z * 6, vector.y * 3 + 2, vector.x * 6] : [-8, 4, -6]}
                intensity={measured ? 0.35 : 0.5}
                color="#38bdf8"
            />
        </>
    );
}

/* ---------------------------------------------------------------- 3D model */

function LoadedModel({ url, normalize }: { url: string; normalize: boolean }) {
    const { scene } = useGLTF(url);

    const object = useMemo(() => {
        // `useGLTF` caches and shares the parsed scene; never mutate it directly.
        const clone = scene.clone(true);
        if (!normalize) return clone;

        const box = new THREE.Box3().setFromObject(clone);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const longest = Math.max(size.x, size.y, size.z) || 1;
        const scale = TARGET_SIZE / longest;
        clone.scale.setScalar(scale);
        // Recentre on the origin so the camera rig always frames it.
        clone.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
        return clone;
    }, [scene, normalize]);

    useEffect(() => {
        useAppStore.setState({ twinModelFallback: false, twinModelReady: true });
    }, []);

    return (
        <>
            <primitive object={object} />
            <RotorAzimuth root={object} />
            <BladeFem root={object} />
        </>
    );
}

/**
 * Turns the blades inside the GLB.
 *
 * The PnP solution is a **single rigid transform** for the whole asset, solved
 * from 11 points that all live on the pontoon and the tower base; the only rotor
 * landmark is `Hub`, so the blade azimuth is a degree of freedom the image
 * cannot constrain. The twin therefore keeps whatever angle the rotor had when
 * the file was exported, which looks like "the blades are 20° off" while the
 * pontoon and the tower line up perfectly.
 *
 * The rotor assembly is the `rotate` node of `OC4.glb` (`rotation` in
 * `OC4-modal.glb`) — a root node either way, so its local frame is the model's
 * own — and the blades spin in a vertical plane: verified offline, the three
 * blades sit at radius 0.0167 with a constant Z, so the axis is +Z.
 */
function RotorAzimuth({ root }: { root: THREE.Object3D }) {
    const node = useMemo(() => {
        for (const name of ROTOR_NODE_NAMES) {
            const found = root.getObjectByName(name);
            if (found) return found;
        }
        // Last resort: the assembly is the root child that carries the most meshes
        // whose name mentions a blade. Beats silently doing nothing.
        let blades = 0;
        let candidate: THREE.Object3D | null = null;
        for (const child of root.children) {
            let count = 0;
            child.traverse((object) => {
                if (/blade/i.test(object.name)) count += 1;
            });
            if (count > blades) {
                blades = count;
                candidate = child;
            }
        }
        if (candidate === null) {
            console.warn('[twin] no encontré el nodo del rotor: las palas no girarán', {
                roots: root.children.map((child) => child.name).slice(0, 20),
            });
        }
        return candidate;
    }, [root]);
    const applied = useRef(Number.NaN);

    /**
     * `?debug=1` publishes which node was found and what angle it was given.
     * Without it, "the blades do not turn" is indistinguishable from "the node
     * was never found", and that is exactly the bug this had.
     */
    useEffect(() => {
        if (!new URLSearchParams(window.location.search).has('debug')) return;
        (window as unknown as Record<string, unknown>).__oc4Rotor = {
            node: node?.name ?? null,
            angleDeg: () => applied.current,
        };
    }, [node]);

    // Read straight from the store inside the render loop: the fitted angle is
    // rewritten on every inference, and a subscription would re-render this
    // component ~10 times a second for a value three.js reads anyway.
    useFrame(() => {
        if (!node) return;
        const { rotorAuto, rotorAngleAuto, rotorAngleDeg } = useAppStore.getState();
        const target = rotorAuto && rotorAngleAuto !== null ? rotorAngleAuto : rotorAngleDeg;
        if (Math.abs(target - applied.current) < 0.05) return;
        node.quaternion.setFromAxisAngle(ROTOR_AXIS, THREE.MathUtils.degToRad(target));
        node.updateMatrix();
        applied.current = target;
    });

    return null;
}


/**
 * Stand-in used before `npm run sync:models` has been run or when the GLB is
 * missing. Deliberately recognisable: three columns on a pontoon ring, tower
 * and rotor, i.e. an OC4-style semi-submersible.
 */
function ProceduralPlatform() {
    useEffect(() => {
        useAppStore.setState({ twinModelFallback: true });
    }, []);

    const body = '#cbd5e1';
    const accent = '#64748b';

    return (
        <group position={[0, -1.6, 0]} scale={1.5}>
            {/* Pontoon ring */}
            <mesh>
                <torusGeometry args={[1.5, 0.16, 12, 48]} />
                <meshStandardMaterial color={accent} roughness={0.7} metalness={0.3} />
            </mesh>
            {/* Columns */}
            {[0, 120, 240].map((angle) => {
                const radians = (angle * Math.PI) / 180;
                return (
                    <mesh key={angle} position={[Math.cos(radians) * 1.5, 0.55, Math.sin(radians) * 1.5]}>
                        <cylinderGeometry args={[0.34, 0.42, 1.7, 20]} />
                        <meshStandardMaterial color={body} roughness={0.6} metalness={0.35} />
                    </mesh>
                );
            })}
            {/* Tower */}
            <mesh position={[0, 2.2, 0]}>
                <cylinderGeometry args={[0.16, 0.3, 2.6, 18]} />
                <meshStandardMaterial color="#e2e8f0" roughness={0.5} metalness={0.4} />
            </mesh>
            {/* Nacelle + rotor */}
            <mesh position={[0, 3.6, -0.5]} rotation={[0, 0, Math.PI / 2]}>
                <capsuleGeometry args={[0.22, 0.5, 6, 12]} />
                <meshStandardMaterial color={body} roughness={0.5} metalness={0.4} />
            </mesh>
            <group position={[0, 3.6, -0.9]} rotation={[Math.PI / 2, 0, 0]}>
                <mesh>
                    <torusGeometry args={[0.12, 0.06, 8, 16]} />
                    <meshStandardMaterial color={accent} />
                </mesh>
                {[0, 120, 240].map((angle) => (
                    <mesh key={angle} rotation={[0, 0, (angle * Math.PI) / 180]} position={[0, 0, 0]}>
                        <boxGeometry args={[0.1, 3, 0.03]} />
                        <meshStandardMaterial color="#f8fafc" roughness={0.4} />
                    </mesh>
                ))}
            </group>
        </group>
    );
}

class ModelErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        console.warn('[twin] no se pudo cargar el modelo glTF, usando la plataforma procedural:', error);
    }

    render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

/* ------------------------------------------------------------ camera rigs */

/**
 * Pose mode: the camera comes from the solved PnP pose, applied on every frame
 * so it tracks the detection without waiting for a React render.
 *
 * With no pose the camera returns to a fixed reference view rather than staying
 * wherever it was. Staying put is what made the twin "disappear": a dropped pose
 * usually means the last one was wrong, and a wrong pose often has the camera
 * inside the platform, looking at nothing from the inside. The reference view is
 * always a sane place to be, and it moves back the moment a pose arrives.
 */
function PoseCamera() {
    const camera = useThree((state) => state.camera);
    const size = useThree((state) => state.size);

    useFrame(() => {
        if (!(camera instanceof THREE.PerspectiveCamera)) return;
        const app = useAppStore.getState();

        if (!app.pose) {
            camera.position.copy(IDLE_CAMERA);
            camera.lookAt(IDLE_TARGET);
            return;
        }

        const intrinsics = intrinsicsFromFov(app.videoSize.width, app.videoSize.height, app.poseHfovDeg);
        applyPoseToCamera(camera, app.pose, intrinsics, {
            width: size.width,
            height: size.height,
            sourceWidth: app.videoSize.width,
            sourceHeight: app.videoSize.height,
        });
    });

    return null;
}

/** Free-look mode: gyroscope when available, otherwise a slow idle orbit. */
function FreeLookRig() {
    const camera = useThree((state) => state.camera);
    const target = useRef(new THREE.Quaternion());
    const euler = useRef(new THREE.Euler());
    const orbitPhase = useRef(0);

    useFrame((_state, delta) => {
        if (!(camera instanceof THREE.PerspectiveCamera)) return;
        const app = useAppStore.getState();

        let yaw = 0;
        let pitch = 0;
        let roll = 0;

        if (app.useGyro && hasGyroSignal()) {
            const gyro = getGyro();
            // alpha: compass → turn left/right. beta: 90° means the phone is upright.
            yaw = THREE.MathUtils.degToRad(shortestAngle(gyro.alpha - getYawReference())) * -1;
            pitch = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(gyro.beta - 90, -65, 65));
            roll = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(gyro.gamma * 0.25, -25, 25));
        } else {
            orbitPhase.current += delta * 0.18;
            yaw = Math.sin(orbitPhase.current) * 0.55;
            pitch = Math.sin(orbitPhase.current * 0.7) * 0.12;
        }

        euler.current.set(pitch, yaw, roll, 'YXZ');
        target.current.setFromEuler(euler.current);
        // Slerp absorbs the 30 Hz sensor rate and the 60 Hz render rate. Con el
        // postprocesado apagado (o su filtro de cámara) se aplica el objetivo tal cual.
        const smoothing = app.postprocess && app.ppCameraSmoothing;
        if (smoothing) camera.quaternion.slerp(target.current, 0.14);
        else camera.quaternion.copy(target.current);
    });

    return null;
}

/* ------------------------------------------------------------- holograms */

function HologramField() {
    const camera = useThree((state) => state.camera);
    const size = useThree((state) => state.size);

    const { group, meshes } = useMemo(() => {
        const container = new THREE.Group();
        container.name = 'hologram-field';
        const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
        const edgeGeometry = new THREE.EdgesGeometry(boxGeometry);
        const created: THREE.Mesh[] = [];

        for (let index = 0; index < MAX_HOLOGRAMS; index += 1) {
            const color = HOLOGRAM_COLORS[index % HOLOGRAM_COLORS.length];
            const face = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.1,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(boxGeometry, face);
            const edges = new THREE.LineSegments(
                edgeGeometry,
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 })
            );
            mesh.add(edges);
            mesh.visible = false;
            mesh.renderOrder = 20;
            container.add(mesh);
            created.push(mesh);
        }
        return { group: container, meshes: created };
    }, []);

    // Parenting to the camera means local coordinates are view-space, which makes
    // the projection maths below exact and cheap.
    useEffect(() => {
        camera.add(group);
        return () => {
            camera.remove(group);
        };
    }, [camera, group]);

    useEffect(
        () => () => {
            group.traverse((child) => {
                if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
                    child.geometry?.dispose?.();
                }
            });
        },
        [group]
    );

    useFrame(() => {
        if (!(camera instanceof THREE.PerspectiveCamera)) return;
        const app = useAppStore.getState();
        // The 3D holograms follow the bounding boxes: with them off, the scene
        // stays clean.
        const visible = app.showBoxes && app.showTwin && app.blend > 0.02;
        const detections = visible ? app.detections : [];
        const { width: srcWidth, height: srcHeight } = app.videoSize;

        if (!visible || srcWidth <= 0 || srcHeight <= 0) {
            for (const mesh of meshes) mesh.visible = false;
            return;
        }

        const cover = computeCover(srcWidth, srcHeight, size.width, size.height, app.mirrored);
        const depth = app.anchorDepth;
        const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * depth;
        const halfWidth = halfHeight * camera.aspect;

        for (let index = 0; index < meshes.length; index += 1) {
            const mesh = meshes[index];
            const detection = detections[index];
            if (!detection) {
                mesh.visible = false;
                continue;
            }
            const [x1, y1, x2, y2] = detection.bbox;
            const [dx1, dy1] = sourceToDisplay(x1, y1, cover, app.mirrored);
            const [dx2, dy2] = sourceToDisplay(x2, y2, cover, app.mirrored);
            const [ndcX, ndcY] = displayToNdc(
                (dx1 + dx2) / 2,
                (dy1 + dy2) / 2,
                size.width,
                size.height
            );

            const ndcWidth = (Math.abs(dx2 - dx1) / size.width) * 2;
            const ndcHeight = (Math.abs(dy2 - dy1) / size.height) * 2;

            mesh.visible = true;
            mesh.position.set(ndcX * halfWidth, ndcY * halfHeight, -depth);
            mesh.scale.set(
                Math.max(0.02, ndcWidth * halfWidth),
                Math.max(0.02, ndcHeight * halfHeight),
                Math.min(0.35, depth * 0.05)
            );
            // Confidence drives the "solidity" of the hologram.
            const material = mesh.material as THREE.MeshBasicMaterial;
            material.opacity = 0.05 + detection.score * 0.22;
        }
    });

    return null;
}

/* ------------------------------------------------------------------ gating */

/**
 * Hides the twin while there is nothing detected to stand on.
 *
 * The rule itself lives in `shouldShowTwin` so it can be tested; here it is just
 * wired to the render tree. The visibility is set on the group *every frame*
 * rather than through a React state change: this runs at 60 Hz and re-rendering
 * the whole scene per frame to flip one boolean would be absurd.
 */
function DetectionGate({ children }: { children: ReactNode }) {
    const group = useRef<THREE.Group>(null);
    const lastSeen = useRef(0);

    useFrame(() => {
        if (!group.current) return;
        const app = useAppStore.getState();
        const now = performance.now();
        if (app.detections.length > 0) lastSeen.current = now;

        group.current.visible = shouldShowTwin({
            poseEnabled: true,
            detections: app.detections.length,
            poseAgeMs: app.poseUpdatedAt ? now - app.poseUpdatedAt : Number.POSITIVE_INFINITY,
            // Measured against the last time a box was seen, not the last pose,
            // so a single missed frame does not blink the twin away.
            sinceDetectionMs: now - lastSeen.current,
        });

        /**
         * Visible motion from the measured residual (OMA).
         *
         * The deviation is in pixels; converting it needs metres-per-pixel at the
         * platform's distance, which is `z / f`. Amplified by `omaGain` because the
         * real residual of a platform seen at 3 m is a couple of pixels.
         *
         * Deliberately **off in `syncFrame` mode**: that offset is the noise of the
         * measurement, not motion of the platform, and over a frozen frame it reads
         * as the twin vibrating on its own — which is exactly the "se desliza"
         * complaint. The colour map keeps showing the modes either way.
         */
        const deviation =
            group.current.visible && !app.syncFrame ? modalTracker.deviation() : null;
        if (!deviation || app.omaGain <= 0) {
            group.current.position.set(0, 0, 0);
            return;
        }
        const { width, height } = app.videoSize;
        const focal =
            width > 0 && height > 0
                ? Math.max(width, height) / 2 / Math.tan((app.poseHfovDeg * Math.PI) / 180 / 2)
                : 0;
        const distance = Math.abs(app.pose?.tvec[2] ?? 3);
        const metresPerPixel = focal > 0 ? distance / focal : 0;
        const scale = metresPerPixel * app.omaGain;
        group.current.position.set(deviation.u * scale, -deviation.v * scale, 0);
    });

    return <group ref={group}>{children}</group>;
}

/* ------------------------------------------------------------------ scene */

export function TwinScene() {
    const poseEnabled = useAppStore((state) => state.poseEnabled);

    const twin = (
        <ModelErrorBoundary fallback={<ProceduralPlatform />}>
            {/* `null`, not the procedural platform: a stand-in that looks almost
          right for two seconds is worse than an explicit "loading". */}
            <Suspense fallback={null}>
                {/* In pose mode the model must keep its native frame and scale: that
              is the frame the 3D keypoints were measured in. */}
                <LoadedModel url={TWIN_MODEL_URL} normalize={!poseEnabled} />
            </Suspense>
        </ModelErrorBoundary>
    );

    return (
        <>
            <hemisphereLight args={['#dbeafe', '#0f172a', 0.9]} />
            <ambientLight intensity={0.35} />
            <SceneLights />

            {poseEnabled ? <DetectionGate>{twin}</DetectionGate> : twin}

            {/* A sea-level reference gives the free-look view a sense of scale. In
          pose mode it would be drawn into the real world, so it is skipped. */}
            {!poseEnabled ? (
                <Grid
                    position={[0, -3.4, 0]}
                    args={[24, 24]}
                    cellSize={0.6}
                    cellThickness={0.5}
                    cellColor="#1e3a5f"
                    sectionSize={3}
                    sectionThickness={1}
                    sectionColor="#38bdf8"
                    fadeDistance={38}
                    fadeStrength={1.4}
                    infiniteGrid
                    followCamera={false}
                />
            ) : null}

            {poseEnabled ? <PoseCamera /> : <FreeLookRig />}
            {/* Holograms are a screen-space crutch for free-look mode; with a solved
          pose the detection already lands on the model. */}
            {!poseEnabled ? <HologramField /> : null}
        </>
    );
}

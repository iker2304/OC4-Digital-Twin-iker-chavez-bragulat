/**
 * Device orientation (gyroscope) as a module-level singleton.
 *
 * The 3D layer reads `getGyro()` from inside `useFrame`, i.e. every animation
 * frame. Routing that through React state would re-render the scene graph 60
 * times per second, so the values live outside React and the 30 Hz sensor rate
 * is smoothed in the consumer instead.
 */
import { useAppStore } from '../store/appStore';

export interface GyroState {
    /** Z axis (compass-ish), degrees. */
    alpha: number;
    /** X axis (front/back tilt), degrees. */
    beta: number;
    /** Y axis (left/right tilt), degrees. */
    gamma: number;
    absolute: boolean;
    /** Timestamp of the last event, used to detect a stalled sensor. */
    updatedAt: number;
}

const state: GyroState = { alpha: 0, beta: 0, gamma: 0, absolute: false, updatedAt: 0 };

let listening = false;

function handleOrientation(event: DeviceOrientationEvent) {
    if (event.alpha === null && event.beta === null && event.gamma === null) return;
    state.alpha = event.alpha ?? 0;
    state.beta = event.beta ?? 0;
    state.gamma = event.gamma ?? 0;
    state.absolute = event.absolute === true;
    state.updatedAt = performance.now();
}

export function getGyro(): GyroState {
    return state;
}

/**
 * Yaw reference ("north" of this session).
 *
 * The compass reading is arbitrary, so the 3D view is driven by the *delta*
 * from a reference captured when the sensor starts. `resetYawReference()` is
 * what the "recentrar" button calls: the twin snaps back to facing the user.
 */
let yawReference: number | null = null;

export function getYawReference(): number {
    if (yawReference === null) yawReference = state.alpha;
    return yawReference;
}

export function resetYawReference(): void {
    yawReference = state.alpha;
}

/** Signed shortest angular difference, so a 359°→1° jump is not seen as -358°. */
export function shortestAngle(delta: number): number {
    let value = ((delta + 180) % 360) - 180;
    if (value < -180) value += 360;
    return value;
}

/** True when a fresh reading arrived recently. */
export function hasGyroSignal(maxAgeMs = 1500): boolean {
    return state.updatedAt > 0 && performance.now() - state.updatedAt < maxAgeMs;
}

function startListening() {
    if (listening) return;
    window.addEventListener('deviceorientation', handleOrientation, { passive: true });
    listening = true;
}

function stopListening() {
    if (!listening) return;
    window.removeEventListener('deviceorientation', handleOrientation);
    listening = false;
}

type PermissionCapable = { requestPermission?: () => Promise<'granted' | 'denied'> };

/**
 * Must be called from a user gesture on iOS 13+. On every other platform the
 * event simply starts flowing.
 */
export async function requestGyroPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
    if (typeof DeviceOrientationEvent === 'undefined') {
        useAppStore.setState({ gyroStatus: 'unsupported', useGyro: false });
        return 'unsupported';
    }

    const requester = DeviceOrientationEvent as unknown as PermissionCapable;
    if (typeof requester.requestPermission === 'function') {
        try {
            const result = await requester.requestPermission();
            if (result !== 'granted') {
                useAppStore.setState({ gyroStatus: 'denied', useGyro: false });
                return 'denied';
            }
        } catch {
            useAppStore.setState({ gyroStatus: 'denied', useGyro: false });
            return 'denied';
        }
    }

    startListening();
    useAppStore.setState({ gyroStatus: 'granted' });

    // Some desktops expose the API but never fire an event; degrade gracefully.
    setTimeout(() => {
        if (!hasGyroSignal(2000)) {
            useAppStore.setState((previous) =>
                previous.gyroStatus === 'granted' ? { gyroStatus: 'unsupported', useGyro: false } : {}
            );
        }
    }, 2200);

    return 'granted';
}

export function releaseGyro() {
    stopListening();
    yawReference = null;
    useAppStore.setState({ gyroStatus: 'idle' });
}

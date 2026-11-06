import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { cameraBlockedReason } from '../env';
import { useAppStore } from '../../store/appStore';

export interface VideoDeviceInfo {
    deviceId: string;
    label: string;
    facing: 'environment' | 'user' | 'unknown';
}

/**
 * Heuristic facing detection. `enumerateDevices()` labels are only readable
 * after permission has been granted, and the facing field itself is not part of
 * the spec — so we sniff the label and fall back to the front/back ordering
 * that every mobile browser follows (back camera first on Android).
 */
function inferFacing(label: string, index: number): 'environment' | 'user' | 'unknown' {
    const text = label.toLowerCase();
    if (/back|rear|environment|trasera|posterior/.test(text)) return 'environment';
    if (/front|user|face|frontal|delantera/.test(text)) return 'user';
    if (/wide|ultra|tele|macro/.test(text)) return 'unknown';
    return index === 0 ? 'environment' : 'unknown';
}

function describeCameraError(error: unknown): string {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    switch (name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'Permiso de cámara denegado. Actívalo en los ajustes del navegador y recarga.';
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return 'No se ha encontrado ninguna cámara en este dispositivo.';
        case 'NotReadableError':
        case 'TrackStartError':
            return 'La cámara está siendo usada por otra aplicación.';
        case 'OverconstrainedError':
            return 'La resolución solicitada no está soportada por esta cámara.';
        default:
            return `No se pudo iniciar la cámara: ${message || name || 'error desconocido'}`;
    }
}

export function useCameraStream() {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const generationRef = useRef(0);

    const stop = useCallback(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        useAppStore.setState({ cameraStatus: 'idle', videoSize: { width: 0, height: 0 } });
    }, []);

    const listDevices = useCallback(async (): Promise<VideoDeviceInfo[]> => {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        const all = await navigator.mediaDevices.enumerateDevices();
        return all
            .filter((device) => device.kind === 'videoinput')
            .map((device, index) => {
                const facing = inferFacing(device.label, index);
                return {
                    deviceId: device.deviceId,
                    label: device.label || `Cámara ${index + 1}`,
                    facing,
                };
            });
    }, []);

    const start = useCallback(
        async (options: { deviceId?: string | null; facing?: 'environment' | 'user' } = {}) => {
            const blocked = cameraBlockedReason();
            if (blocked) {
                useAppStore.setState({ cameraStatus: 'error', cameraError: blocked });
                return false;
            }

            const generation = generationRef.current + 1;
            generationRef.current = generation;
            useAppStore.setState({ cameraStatus: 'requesting', cameraError: null });

            const requestedFacing = options.facing ?? useAppStore.getState().facing;
            const deviceId = options.deviceId ?? useAppStore.getState().deviceId;
            const base = {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30, max: 30 },
            };
            const attempts: MediaTrackConstraints[] = [
                { ...base, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: requestedFacing } }) },
                // Fallbacks: some Android builds reject the frameRate hint outright.
                { ...base, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: requestedFacing }) },
                { facingMode: requestedFacing },
            ];
            if (deviceId) attempts.push({ facingMode: requestedFacing });

            let lastError: unknown = null;
            for (const constraints of attempts) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
                    if (generation !== generationRef.current) {
                        stream.getTracks().forEach((track) => track.stop());
                        return false;
                    }

                    streamRef.current?.getTracks().forEach((track) => track.stop());
                    streamRef.current = stream;

                    const video = videoRef.current;
                    if (video) {
                        video.srcObject = stream;
                        // iOS needs both attributes before play() resolves.
                        video.muted = true;
                        try {
                            await video.play();
                        } catch {
                            /* autoplay rejection is recoverable: the user gesture already happened */
                        }
                    }

                    // Tell the OS/browser to stop guessing: pick the closest real mode.
                    const track = stream.getVideoTracks()[0];
                    const settings = track?.getSettings();
                    const actualDeviceId = settings?.deviceId ?? deviceId ?? null;
                    const actualFacing =
                        settings?.facingMode === 'user' || settings?.facingMode === 'environment'
                            ? settings.facingMode
                            : requestedFacing;

                    useAppStore.setState({
                        cameraStatus: 'ready',
                        cameraError: null,
                        deviceId: actualDeviceId,
                        facing: actualFacing,
                        mirrored: actualFacing === 'user',
                        videoSize: {
                            width: settings?.width ?? video?.videoWidth ?? 0,
                            height: settings?.height ?? video?.videoHeight ?? 0,
                        },
                    });

                    track?.addEventListener('ended', () => {
                        if (generation === generationRef.current) {
                            useAppStore.setState({
                                cameraStatus: 'error',
                                cameraError: 'La cámara dejó de emitir (¿otra app la ha tomado?).',
                            });
                        }
                    });

                    return true;
                } catch (error) {
                    lastError = error;
                }
            }

            useAppStore.setState({ cameraStatus: 'error', cameraError: describeCameraError(lastError) });
            return false;
        },
        []
    );

    const flip = useCallback(async () => {
        const next = useAppStore.getState().facing === 'environment' ? 'user' : 'environment';
        // A specific deviceId always wins over facingMode, so drop it when flipping.
        await start({ facing: next, deviceId: null });
    }, [start]);

    /**
     * Callback ref for every `<video>` that should show the live stream.
     *
     * A plain `RefObject` is not enough: the onboarding preview and the live stage
     * mount different elements, and each new element needs `srcObject` re-assigned
     * or it renders black.
     */
    const attach = useCallback((element: HTMLVideoElement | null) => {
        videoRef.current = element;
        if (!element) return;
        element.muted = true;
        const stream = streamRef.current;
        if (stream && element.srcObject !== stream) {
            element.srcObject = stream;
            void element.play().catch(() => undefined);
        }
    }, []);

    useEffect(() => () => stop(), [stop]);

    return { videoRef, attach, start, stop, flip, listDevices };
}

/** Keeps the store's `videoSize` in sync with the element that actually decoded. */
export function useVideoMetadata(videoRef: RefObject<HTMLVideoElement | null>, key?: unknown) {
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const sync = () => {
            if (video.videoWidth > 0) {
                useAppStore.setState({
                    videoSize: { width: video.videoWidth, height: video.videoHeight },
                });
            }
        };
        video.addEventListener('loadedmetadata', sync);
        video.addEventListener('resize', sync);
        sync();
        return () => {
            video.removeEventListener('loadedmetadata', sync);
            video.removeEventListener('resize', sync);
        };
        // `key` re-binds the listeners when the <video> element is swapped (the
        // onboarding preview and the live stage are different DOM nodes).
    }, [videoRef, key]);
}

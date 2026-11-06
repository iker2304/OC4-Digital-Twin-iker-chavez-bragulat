import { useCallback, useEffect, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { useAppStore } from './store/appStore';
import { useOrientation } from './lib/useOrientation';
import { useCameraStream, useVideoMetadata } from './lib/camera/useCameraStream';
import { useDetectionEngine } from './lib/inference/useDetectionEngine';
import { useInferenceLoop } from './lib/inference/useInferenceLoop';
import { AUTOLOAD_MODEL, TWIN_MODEL_URL } from './lib/env';
import { useTelemetry } from './lib/telemetry';
import { requestGyroPermission, resetYawReference } from './lib/useDeviceOrientation';
import { Onboarding } from './components/onboarding/Onboarding';
import { LiveStage } from './components/live/LiveStage';

export default function App() {
    const stage = useAppStore((state) => state.stage);
    const cameraStatus = useAppStore((state) => state.cameraStatus);
    const update = useAppStore((state) => state.update);

    const { layout } = useOrientation();
    const { videoRef, attach, start, flip, listDevices } = useCameraStream();
    const { engine, loadFromFile, loadFromUrl, unload, benchmark, bundledModelUrl } = useDetectionEngine();

    useVideoMetadata(videoRef, stage);
    useTelemetry();

    /**
     * Load the bundled model on first paint so nobody has to pick a file.
     * `silent: true` keeps the app usable when the model has not been synced yet
     * (`npm run sync:models`), and the ref makes it a one-shot even under
     * StrictMode's double-invoked effects — otherwise a 38 MB fetch would run twice.
     */
    const autoLoadStarted = useRef(false);
    useEffect(() => {
        if (autoLoadStarted.current || !bundledModelUrl || !AUTOLOAD_MODEL) return;
        autoLoadStarted.current = true;
        void loadFromUrl(bundledModelUrl, { silent: true });
    }, [bundledModelUrl, loadFromUrl]);

    // The loop is gated on the live stage AND a ready camera: running inference on
    // a black frame would burn battery for nothing.
    useInferenceLoop({
        videoRef,
        engine,
        enabled: stage === 'live' && cameraStatus === 'ready',
    });

    /**
     * Warm the 3D asset while the user is still reading the intro.
     *
     * The GLB is ~10 MB and parsing it takes a moment on a phone; doing it on
     * entering the live view means the first seconds of the overlay are empty
     * (or, worse, show the procedural stand-in and then swap). Preloading waits
     * for the ONNX model to settle first so the two downloads do not compete for
     * the same uplink.
     */
    const twinPreloaded = useRef(false);
    const modelSettled = useAppStore((state) => state.modelStatus === 'ready' || state.modelStatus === 'error');
    useEffect(() => {
        if (twinPreloaded.current || !modelSettled) return;
        twinPreloaded.current = true;
        useGLTF.preload(TWIN_MODEL_URL);
    }, [modelSettled]);

    useEffect(() => {
        document.documentElement.classList.toggle('oc4-locked', stage === 'live');
        return () => document.documentElement.classList.remove('oc4-locked');
    }, [stage]);

    const enterLive = useCallback(() => {
        // iOS only grants motion sensor access from inside a user gesture, so this
        // must stay synchronous with the tap that triggers it.
        void requestGyroPermission();
        update({ stage: 'live' });
    }, [update]);

    const exitLive = useCallback(() => {
        // Free the GPU/CPU while the user is back in the onboarding deck.
        resetYawReference();
        useAppStore.setState({ detections: [], metrics: { fps: 0, inferenceMs: 0, preprocessMs: 0, postprocessMs: 0, detected: 0, latencyMs: 0, poseMs: 0 } });
        update({ stage: 'onboarding' });
    }, [update]);

    const handleRequestGyro = useCallback(() => {
        void requestGyroPermission();
    }, []);

    const modelProps = {
        onModelFile: loadFromFile,
        onModelUrl: loadFromUrl,
        bundledModelUrl,
    };

    if (stage === 'live') {
        return (
            <LiveStage
                attachVideo={attach}
                orientation={layout}
                onExit={exitLive}
                onFlipCamera={() => void flip()}
                onRecenter={resetYawReference}
                onRequestGyro={handleRequestGyro}
                onUnloadModel={unload}
                onBenchmark={benchmark}
                {...modelProps}
            />
        );
    }

    return (
        <Onboarding
            layout={layout}
            onEnter={enterLive}
            attachVideo={attach}
            startCamera={start}
            listDevices={listDevices}
            {...modelProps}
        />
    );
}

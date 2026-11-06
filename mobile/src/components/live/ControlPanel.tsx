import { Compass, Crosshair, Gauge, RefreshCcw, RotateCcw, Trash2, Wifi } from 'lucide-react';
import { persistPreferWebGpu, useAppStore } from '../../store/appStore';
import { Button, Chip, SliderRow, Toggle } from '../ui/primitives';
import { ModelPicker } from '../ModelPicker';
import { LightSection } from './LightSection';
import { isCrossOriginIsolated } from '../../lib/env';
import { clearWebGpuBlock } from '../../lib/inference/ortAssets';
import { KEYPOINTS_SCENE } from '../../lib/pose/keypoints3d';

/**
 * Live metrics keep to themselves: they change ~15 times per second and must
 * not drag the whole control panel (sliders, switches) through a re-render.
 */
function MetricsChips() {
    const fps = useAppStore((state) => state.metrics.fps);
    const inferenceMs = useAppStore((state) => state.metrics.inferenceMs);
    const preprocessMs = useAppStore((state) => state.metrics.preprocessMs);
    const postprocessMs = useAppStore((state) => state.metrics.postprocessMs);
    const detected = useAppStore((state) => state.metrics.detected);
    const latencyMs = useAppStore((state) => state.metrics.latencyMs);
    const poseMs = useAppStore((state) => state.metrics.poseMs);
    const provider = useAppStore((state) => state.model?.provider ?? null);
    const rotorAuto = useAppStore((state) => state.rotorAuto);
    const rotorAngleAuto = useAppStore((state) => state.rotorAngleAuto);
    const rotorAngleDeg = useAppStore((state) => state.rotorAngleDeg);

    /**
     * Where the time goes, as a share of the measured end-to-end latency.
     *
     * Absolute milliseconds hide the answer ("97 ms of what?"); the percentages
     * make the culprit obvious at a glance. The leftover is what the pipeline
     * itself costs (frame grab, decoding, store updates) — the number that should
     * stay small.
     */
    const parts = [
        { key: 'pre', label: 'pre', ms: preprocessMs, color: 'bg-sky-400' },
        { key: 'yolo', label: 'yolo', ms: inferenceMs, color: 'bg-fuchsia-400' },
        { key: 'post', label: 'post', ms: postprocessMs, color: 'bg-amber-400' },
        { key: 'pnp', label: 'pnp', ms: poseMs, color: 'bg-emerald-400' },
    ];
    const accounted = parts.reduce((sum, part) => sum + part.ms, 0);
    /**
     * Each part is an instantaneous value while `latencyMs` is an average, so the
     * sum can overshoot it by a hair. Take whichever is larger as the whole, so
     * the bar never adds up to more than 100 %.
     */
    const total = Math.max(latencyMs, accounted, 1);
    const shares = parts.map((part) => ({ ...part, share: Math.round((part.ms / total) * 100) }));
    const restMs = Math.max(0, total - accounted);
    const restShare = Math.max(0, 100 - shares.reduce((sum, part) => sum + part.share, 0));
    const rotorAngle = rotorAuto && rotorAngleAuto !== null ? rotorAngleAuto : rotorAngleDeg;

    return (
        <div className="space-y-1.5 px-1 pt-1">
            <div className="flex flex-wrap gap-2">
                <Chip tone="info">{fps} fps</Chip>
                <Chip tone={latencyMs > 400 ? 'warn' : 'neutral'}>total {latencyMs} ms</Chip>
                <Chip>{inferenceMs} ms yolo</Chip>
                <Chip>{poseMs} ms pnp</Chip>
                <Chip tone={rotorAuto && rotorAngleAuto !== null ? 'good' : 'neutral'}>
                    rotor {Math.round(rotorAngle)}°
                </Chip>
                <Chip>{detected} obj</Chip>
                {provider ? (
                    <Chip tone={provider === 'webgpu' ? 'good' : 'neutral'}>{provider}</Chip>
                ) : null}
                {!isCrossOriginIsolated() ? <Chip tone="warn">WASM 1 hilo</Chip> : null}
            </div>

            {/* Stacked bar: the same numbers as above, but proportional. */}
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                {shares.map((part) => (
                    <div
                        key={part.key}
                        className={part.color}
                        style={{ width: `${part.share}%` }}
                        title={`${part.label} ${part.ms} ms (${part.share}%)`}
                    />
                ))}
                <div
                    className="bg-slate-600"
                    style={{ width: `${restShare}%` }}
                    title={`pipeline ${Math.round(restMs)} ms (${restShare}%)`}
                />
            </div>
            <p className="text-[11px] text-slate-400">
                {shares.map((part) => `${part.label} ${part.share}%`).join(' · ')} · pipeline {restShare}%
                <span className="text-slate-500"> — sobre {latencyMs} ms de extremo a extremo</span>
            </p>
        </div>
    );
}

/**
 * Pose quality, isolated for the same reason as the metrics: it changes with
 * every inference frame and must not re-render the whole panel.
 */
function PoseReadout() {
    const pose = useAppStore((state) => state.pose);
    const updatedAt = useAppStore((state) => state.poseUpdatedAt);
    const detected = useAppStore((state) => state.metrics.detected);

    const age = updatedAt > 0 ? Math.round((Date.now() - updatedAt) / 1000) : null;
    const distance = pose ? Math.hypot(pose.tvec[0], pose.tvec[1], pose.tvec[2]) : null;

    return (
        <div className="flex flex-wrap gap-2 px-1">
            {pose ? (
                <Chip tone="good">pose</Chip>
            ) : (
                <Chip tone={detected > 0 ? 'warn' : 'neutral'}>sin pose</Chip>
            )}
            {pose ? (
                <Chip>
                    {pose.inliers}/{KEYPOINTS_SCENE.length} kpts
                </Chip>
            ) : null}
            {pose ? <Chip>{pose.rmsError.toFixed(1)} px</Chip> : null}
            {distance !== null ? <Chip>{distance.toFixed(2)} m</Chip> : null}
            {age !== null ? <Chip>{age}s</Chip> : null}
        </div>
    );
}

export interface ControlPanelProps {
    onFlipCamera: () => void;
    onRequestGyro: () => void;
    onRecenter: () => void;
    onUnloadModel: () => void;
    /** Runs the thread benchmark and applies the winner. */
    onBenchmark: () => void;
    onModelFile: (file: File, labelsFile?: File | null) => void | Promise<void>;
    onModelUrl: (url: string) => void | Promise<void>;
    bundledModelUrl?: string;
}

export function ControlPanel({
    onFlipCamera,
    onRequestGyro,
    onRecenter,
    onUnloadModel,
    onBenchmark,
    onModelFile,
    onModelUrl,
    bundledModelUrl,
}: ControlPanelProps) {
    const update = useAppStore((state) => state.update);
    const preferWebGpu = useAppStore((state) => state.preferWebGpu);
    const benchRunning = useAppStore((state) => state.benchRunning);
    const benchProgress = useAppStore((state) => state.benchProgress);
    const benchResult = useAppStore((state) => state.benchResult);

    const confidence = useAppStore((state) => state.confidence);
    const iou = useAppStore((state) => state.iou);
    const maxFps = useAppStore((state) => state.maxFps);
    const showBoxes = useAppStore((state) => state.showBoxes);
    const showKeypoints = useAppStore((state) => state.showKeypoints);
    const showTwin = useAppStore((state) => state.showTwin);
    const twinOpacity = useAppStore((state) => state.twinOpacity);
    const anchorDepth = useAppStore((state) => state.anchorDepth);
    const useGyro = useAppStore((state) => state.useGyro);
    const gyroStatus = useAppStore((state) => state.gyroStatus);
    const telemetryEnabled = useAppStore((state) => state.telemetryEnabled);
    const telemetryStatus = useAppStore((state) => state.telemetryStatus);
    const twinModelFallback = useAppStore((state) => state.twinModelFallback);
    const hasModel = useAppStore((state) => state.model !== null);
    const poseEnabled = useAppStore((state) => state.poseEnabled);
    const hasPose = useAppStore((state) => state.pose !== null);
    const poseHfovDeg = useAppStore((state) => state.poseHfovDeg);
    const rotorAngleDeg = useAppStore((state) => state.rotorAngleDeg);
    const rotorAuto = useAppStore((state) => state.rotorAuto);
    const syncFrame = useAppStore((state) => state.syncFrame);
    const postprocess = useAppStore((state) => state.postprocess);
    const ppJumpGuard = useAppStore((state) => state.ppJumpGuard);
    const ppRotorSmoothing = useAppStore((state) => state.ppRotorSmoothing);
    const ppCameraSmoothing = useAppStore((state) => state.ppCameraSmoothing);
    const keypointMinScore = useAppStore((state) => state.keypointMinScore);
    const showReprojection = useAppStore((state) => state.showReprojection);
    const mirrored = useAppStore((state) => state.mirrored);
    const gyroUsable = gyroStatus === 'granted';
    const gyroLabel =
        gyroStatus === 'unsupported'
            ? 'Giroscopio no disponible'
            : gyroStatus === 'denied'
                ? 'Giroscopio denegado'
                : 'Giroscopio activo';

    return (
        <div className="space-y-4">
            <section className="space-y-2">
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Pose (PnP)
                </h3>
                <Toggle
                    label="Alinear el gemelo con la detección"
                    checked={poseEnabled}
                    onChange={(value) => update({ poseEnabled: value, pose: null })}
                />
                {poseEnabled ? <PoseReadout /> : null}
                {poseEnabled ? (
                    <SliderRow
                        label="Campo de visión"
                        value={poseHfovDeg}
                        min={40}
                        max={110}
                        step={1}
                        onChange={(value) => update({ poseHfovDeg: value })}
                        format={(value) => `${value}°`}
                        hint="Del lado largo de la imagen (da igual si el móvil está vertical u horizontal). Un móvil típico ronda los 68°."
                    />
                ) : null}
                {poseEnabled ? (
                    <SliderRow
                        label="Confianza mínima de keypoint"
                        value={keypointMinScore}
                        min={0.2}
                        max={0.9}
                        step={0.05}
                        onChange={(value) => update({ keypointMinScore: value })}
                        format={(value) => value.toFixed(2)}
                    />
                ) : null}
                {poseEnabled ? (
                    <Toggle
                        label="Marcar keypoints reproyectados"
                        checked={showReprojection}
                        onChange={(value) => update({ showReprojection: value })}
                    />
                ) : null}
                {poseEnabled ? (
                    <Toggle
                        label="Ajustar las palas automáticamente"
                        checked={rotorAuto}
                        onChange={(value) => update({ rotorAuto: value })}
                    />
                ) : null}
                {poseEnabled && rotorAuto ? (
                    <p className="px-1 text-[11px] text-slate-400">
                        El giro del rotor no lo puede ver el PnP (solo hay un keypoint en el buje): se ajusta con
                        los puntos de pala de la clase Rotor. Desactívalo para girarlo a mano.
                    </p>
                ) : null}
                {poseEnabled && !rotorAuto ? (
                    <SliderRow
                        label="Ángulo del rotor"
                        value={rotorAngleDeg}
                        min={0}
                        max={359}
                        step={1}
                        onChange={(value) => update({ rotorAngleDeg: value })}
                        format={(value) => `${value}°`}
                        hint="La pose es un único giro rígido de todo el modelo: con solo el keypoint del buje, el PnP no puede saber cuánto han girado las palas."
                    />
                ) : null}
                {poseEnabled && hasPose ? (
                    <Button
                        variant="outline"
                        full
                        icon={<RotateCcw className="h-4 w-4" />}
                        onClick={() => update({ pose: null })}
                    >
                        Reiniciar la pose
                    </Button>
                ) : null}
                {poseEnabled && mirrored ? (
                    <p className="px-1 text-[11px] text-amber-300/90">
                        En modo PnP la vista no se espeja: la pose se resuelve en el encuadre real de la cámara.
                        Para ver la plataforma con la cámara frontal, cambia a la trasera.
                    </p>
                ) : null}
            </section>

            <section className="space-y-2">
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Capas
                </h3>
                <Toggle
                    label="Bounding boxes"
                    checked={showBoxes}
                    onChange={(value) => update({ showBoxes: value })}
                />
                <Toggle
                    label="Keypoints detectados"
                    checked={showKeypoints}
                    onChange={(value) => update({ showKeypoints: value })}
                />
                <Toggle
                    label="Gemelo digital (3D)"
                    checked={showTwin}
                    onChange={(value) => update({ showTwin: value })}
                />
                {showTwin ? (
                    <SliderRow
                        label="Opacidad del gemelo"
                        value={twinOpacity}
                        min={0.1}
                        max={1}
                        step={0.05}
                        onChange={(value) => update({ twinOpacity: value })}
                        format={(value) => `${Math.round(value * 100)}%`}
                    />
                ) : null}
                {showTwin ? (
                    <SliderRow
                        label="Profundidad de anclaje"
                        value={anchorDepth}
                        min={1.5}
                        max={20}
                        step={0.5}
                        onChange={(value) => update({ anchorDepth: value })}
                        format={(value) => `${value.toFixed(1)} m`}
                        hint="Distancia a la que se anclan las cajas dentro de la escena 3D."
                    />
                ) : null}
                {twinModelFallback ? (
                    <p className="px-1 text-[11px] text-amber-300/90">
                        Plataforma procedural activa: ejecuta <code>npm run sync:models</code> para copiar{' '}
                        <code>OC4.glb</code>.
                    </p>
                ) : null}
            </section>

            <section className="space-y-2">
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Inferencia
                </h3>
                <SliderRow
                    label="Confianza mínima"
                    value={confidence}
                    min={0.05}
                    max={0.95}
                    step={0.05}
                    onChange={(value) => update({ confidence: value })}
                    format={(value) => value.toFixed(2)}
                />
                <SliderRow
                    label="Umbral NMS (IoU)"
                    value={iou}
                    min={0.1}
                    max={0.9}
                    step={0.05}
                    onChange={(value) => update({ iou: value })}
                    format={(value) => value.toFixed(2)}
                />
                <SliderRow
                    label="FPS máximos"
                    value={maxFps}
                    min={1}
                    max={30}
                    step={1}
                    onChange={(value) => update({ maxFps: value })}
                    format={(value) => `${value} fps`}
                    hint="Menos FPS = menos calor y más batería. Entre 5 y 10 el seguimiento va más estable, porque los keypoints se mueven menos entre frames."
                />
                <MetricsChips />
            </section>

            <section className="space-y-2">
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Cámara y orientación
                </h3>
                <div className="flex flex-wrap gap-2">
                    <Button icon={<RefreshCcw className="h-4 w-4" />} onClick={onFlipCamera}>
                        Girar cámara
                    </Button>
                    <Button icon={<Crosshair className="h-4 w-4" />} onClick={onRecenter} disabled={!gyroUsable}>
                        Recentrar
                    </Button>
                </div>
                <Toggle
                    label={gyroLabel}
                    checked={useGyro && gyroUsable}
                    disabled={gyroStatus === 'unsupported'}
                    onChange={(value) => {
                        if (value && gyroStatus !== 'granted') {
                            onRequestGyro();
                            return;
                        }
                        update({ useGyro: value });
                    }}
                />
                <Toggle
                    label="Ver el frame inferido"
                    checked={syncFrame}
                    onChange={(value) => update({ syncFrame: value })}
                />
                <p className="px-1 text-[11px] text-slate-500">
                    Activado, la imagen que ves es exactamente la que analizó el modelo: cajas, keypoints y
                    gemelo caen sobre sus píxeles, sin «resbalar» cuando mueves la cámara. Desactívalo para ver
                    la cámara en directo y el retardo real de la inferencia.
                </p>
                <Toggle
                    label="Postprocesado"
                    checked={postprocess}
                    onChange={(value) => update({ postprocess: value })}
                />
                <p className="px-1 text-[11px] text-slate-500">
                    Los filtros temporales que estabilizan el gemelo. Desactivado, cada inferencia se pinta
                    tal cual sale del solver: deja de «perseguir» la posición al pausar, a cambio de un gemelo
                    más nervioso. Con él apagado también se corta la extrapolación entre inferencias.
                </p>
                {postprocess ? (
                    <div className="ml-2 space-y-1 border-l border-slate-800 pl-3">
                        <Toggle
                            label="Guardia de saltos"
                            checked={ppJumpGuard}
                            onChange={(value) => update({ ppJumpGuard: value })}
                        />
                        <p className="px-1 text-[11px] text-slate-500">
                            Descarta una pose que implique un salto imposible de cámara. Es lo que hace que el
                            gemelo se quede atrás cuando el sujeto gira rápido.
                        </p>
                        <Toggle
                            label="Suavizado del rotor"
                            checked={ppRotorSmoothing}
                            onChange={(value) => update({ ppRotorSmoothing: value })}
                        />
                        <p className="px-1 text-[11px] text-slate-500">
                            Media exponencial del ángulo de las aspas (40 % por inferencia). Apágalo para que el
                            rotor siga la medición exacta.
                        </p>
                        <Toggle
                            label="Suavizado de cámara"
                            checked={ppCameraSmoothing}
                            onChange={(value) => update({ ppCameraSmoothing: value })}
                        />
                        <p className="px-1 text-[11px] text-slate-500">
                            Slerp del objetivo del giroscopio/orbitación hacia la cámara 3D.
                        </p>
                    </div>
                ) : null}
                {gyroStatus !== 'granted' && gyroStatus !== 'unsupported' ? (
                    <Button variant="outline" full icon={<Compass className="h-4 w-4" />} onClick={onRequestGyro}>
                        Activar sensores de movimiento
                    </Button>
                ) : null}
            </section>

            <section className="space-y-2">
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Telemetría (opcional)
                </h3>
                <Toggle
                    label="Enviar detecciones al servidor"
                    checked={telemetryEnabled}
                    onChange={(value) => update({ telemetryEnabled: value })}
                />
                <div className="flex items-center gap-2 px-1">
                    <Wifi className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <span className="text-[11px] text-slate-400">
                        {telemetryStatus === 'off'
                            ? 'Desactivada'
                            : telemetryStatus === 'online'
                                ? 'Servidor conectado'
                                : telemetryStatus === 'connecting'
                                    ? 'Comprobando…'
                                    : telemetryStatus === 'offline'
                                        ? 'Servidor no disponible (la app sigue funcionando)'
                                        : 'Error de telemetría'}
                    </span>
                </div>
            </section>

            <LightSection />

            <section className="space-y-2">
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Modelo ONNX
                </h3>
                <ModelPicker
                    compact
                    onFile={onModelFile}
                    onUrl={onModelUrl}
                    bundledModelUrl={bundledModelUrl}
                />
                <Toggle
                    label="Preferir WebGPU"
                    checked={preferWebGpu}
                    onChange={(value) => {
                        // Turning it back on is explicit intent: allow the 28 MB
                        // WebGPU runtime one more try on this device.
                        if (value) clearWebGpuBlock();
                        persistPreferWebGpu(value);
                        update({ preferWebGpu: value });
                        // Apply it now instead of on the next page load: the
                        // bundled model is auto-loaded before this panel exists,
                        // so without a reload the switch changes nothing at all.
                        if (bundledModelUrl) void onModelUrl(bundledModelUrl);
                    }}
                />
                <p className="px-1 text-[11px] text-slate-500">
                    Apagado por defecto: con WebGPU la primera sesión puede arrancar sin detectar nada hasta
                    recargar el modelo. Actívalo si mides y va más rápido: recarga el modelo al instante y la
                    preferencia se guarda para la próxima visita.
                </p>
                <Button
                    variant="outline"
                    full
                    disabled={benchRunning}
                    icon={<Gauge className="h-4 w-4" />}
                    onClick={onBenchmark}
                >
                    {benchRunning ? 'Midiendo…' : 'Medir hilos (calibrar este móvil)'}
                </Button>
                {benchProgress ? (
                    <p className="px-1 text-[11px] text-sky-300/90">Probando {benchProgress}</p>
                ) : null}
                {benchResult ? (
                    <p className="px-1 text-[11px] text-slate-400">{benchResult}</p>
                ) : (
                    <p className="px-1 text-[11px] text-slate-500">
                        Prueba 1, 2, 4, 6 y 8 hilos y se queda con el más rápido de este dispositivo
                        (tarda ~30-60 s y conviene hacerlo con el móvil frío). El resultado se guarda.
                    </p>
                )}
                {hasModel ? (
                    <Button variant="danger" full icon={<Trash2 className="h-4 w-4" />} onClick={onUnloadModel}>
                        Descargar modelo
                    </Button>
                ) : (
                    <p className="px-1 text-[11px] text-slate-500">
                        Sin modelo no hay detecciones, pero la cámara y el gemelo siguen funcionando.
                    </p>
                )}
            </section>
        </div>
    );
}

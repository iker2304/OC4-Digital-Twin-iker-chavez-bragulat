/**
 * FemMeshViewer.tsx — OMA Modal Visualization Toggle
 *
 * Wraps the existing ModelViewer (GLB OC4 model) and adds:
 *  - A mode toggle: "Live Mirror" (time domain) ↔ "Modal Explorer" (frequency domain)
 *  - A WebSocket connection to /api/fem/modal-filtered-ws for band-pass IFFT data
 *  - Vertex morphing of the GLB mesh using modal superposition
 *  - An amplitude slider for the Modal Explorer synthetic oscillation
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ Modo 1 — Live Mirror (viewMode = 'time')                            │
 * │   WebSocket → q_i(t)_IFFT → x_mesh(t) = Σ Φ_FEM,i · q_i(t)       │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ Modo 2 — Modal Explorer (viewMode = 'frequency')                    │
 * │   WS paused → user clicks peak → x_mesh = A·Φ_FEM,n·sin(2π f_n t) │
 * └─────────────────────────────────────────────────────────────────────┘
 */
import {
  Suspense, useEffect, useRef, useCallback, useState
} from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
  Grid, Environment, useGLTF,
  PerspectiveCamera, CameraControls, ContactShadows, Stars
} from '@react-three/drei';
import * as THREE from 'three';
import {
  Activity, Radio, ZapOff, ChevronDown, ChevronUp,
  BarChart2, Clock, Sliders
} from 'lucide-react';

import { useModalStore } from '../../store/modalStore';
import type { ModalFilteredMessage } from '../../types';
import {
  buildModeShapeArray, computeModalSuperposition,
  computeHarmonicOscillation, applyVerticesToGeometry
} from '../../lib/femUtils';
import { SpectrumChart } from './SpectrumChart';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_URL = '/models/OC4.glb';
const WS_URL = 'ws://localhost:8080/api/fem/modal-filtered-ws';

// ── ModalMeshController — Three.js inner component ────────────────────────────
/**
 * Runs inside the Canvas. Each frame it:
 *  - MODE 1: Reads q_modal from the store → computes superposition → morphs vertices.
 *  - MODE 2: Uses internal clock + selected mode → computes harmonic offsets → morphs vertices.
 *
 * Strategy: Clone the GLB scene's position buffers on load to get "rest" positions,
 * then write deformed positions each frame without modifying the original geometry.
 */
const ModalMeshController = () => {
  const { scene: glbScene } = useGLTF(MODEL_URL) as any;

  // ── Refs for per-mesh base position buffers ─────────────────────────────
  // We store {mesh → Float32Array of original positions} so we can always
  // add offsets relative to the rest shape, not the previously deformed shape.
  const basePositions = useRef<Map<THREE.Mesh, Float32Array>>(new Map());
  const modeShapeArraysRef = useRef<Record<number, Float32Array>>({});
  const nodeOrderRef = useRef<string[]>([]);
  const sceneReady = useRef(false);

  // femModeShapes and femShapesLoaded are used in the useEffect below.
  // viewMode, selectedModeId, selectedModeFreq, amplitudeScale, and qModal
  // are read directly via useModalStore.getState() inside useFrame to avoid
  // stale closure issues — they are NOT subscribed as React state here.
  const femModeShapes   = useModalStore((s) => s.femModeShapes);
  const femShapesLoaded = useModalStore((s) => s.femShapesLoaded);

  // ── Simulation clock for Modal Explorer ─────────────────────────────────
  const simClock = useRef(0);

  // ── Initialise: capture base positions + build mode shape arrays ─────────
  useEffect(() => {
    if (!glbScene || !femShapesLoaded) return;

    // 1. Collect all meshes and capture their rest positions
    const meshes: THREE.Mesh[] = [];
    glbScene.traverse((child: any) => {
      if (child.isMesh && child.geometry?.attributes?.position) {
        meshes.push(child as THREE.Mesh);
        const posAttr = child.geometry.attributes.position;
        const copy = new Float32Array(posAttr.array.length);
        copy.set(posAttr.array);
        basePositions.current.set(child as THREE.Mesh, copy);
      }
    });

    // 2. Build a canonical node order from the first mode shape
    //    We use the mode 1 shape if available (or the first available mode).
    const firstMode = Object.values(femModeShapes)[0];
    if (firstMode) {
      nodeOrderRef.current = Object.keys(firstMode.nodes).sort(
        (a, b) => parseInt(a) - parseInt(b)
      );
    }

    // 3. Pre-build flat displacement arrays Φ_FEM,i for all modes
    const arrays: Record<number, Float32Array> = {};
    for (const [modeIdStr, modeData] of Object.entries(femModeShapes)) {
      const modeId = parseInt(modeIdStr, 10);
      arrays[modeId] = buildModeShapeArray(modeData, nodeOrderRef.current);
    }
    modeShapeArraysRef.current = arrays;
    sceneReady.current = true;

    console.log(
      `[ModalMeshController] ${meshes.length} meshes ready, ` +
      `${Object.keys(arrays).length} mode shapes pre-computed.`
    );
  }, [glbScene, femShapesLoaded, femModeShapes]);

  // ── Animation loop ────────────────────────────────────────────────────────
  useFrame((_state, delta) => {
    if (!sceneReady.current || !glbScene) return;

    simClock.current += delta;
    const { viewMode: vm, qModal, selectedModeId: mId, selectedModeFreq: mFreq,
            amplitudeScale: A } = useModalStore.getState();

    // Apply deformation to every mesh in the GLB
    glbScene.traverse((child: any) => {
      if (!child.isMesh) return;
      const mesh = child as THREE.Mesh;
      const base = basePositions.current.get(mesh);
      if (!base) return;

      const posAttr = mesh.geometry.attributes.position;
      const targetArr = posAttr.array as Float32Array;
      const nVerts = base.length / 3;

      let offsets: Float32Array;

      if (vm === 'time') {
        // ── MODE 1: Modal Superposition (Live Mirror) ──────────────────
        // x_mesh(t) = Σ_i  Φ_FEM,i · q_i(t)_IFFT
        offsets = computeModalSuperposition(
          modeShapeArraysRef.current,
          qModal,
          nVerts
        );
      } else {
        // ── MODE 2: Harmonic Oscillation (Modal Explorer) ──────────────
        // x_mesh(t_sim) = A · Φ_FEM,n · sin(2π f_n · t_sim)
        if (mId !== null && mFreq !== null && modeShapeArraysRef.current[mId]) {
          offsets = computeHarmonicOscillation(
            modeShapeArraysRef.current[mId],
            mFreq,
            simClock.current,
            A
          );
        } else {
          // No mode selected — show rest shape
          offsets = new Float32Array(nVerts * 3);
        }
      }

      // Write deformed positions into the BufferAttribute
      applyVerticesToGeometry(base, offsets, targetArr);
      posAttr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    });
  });

  return <primitive object={glbScene} />;
};

// ── View mode toggle button ────────────────────────────────────────────────────

interface ToggleProps {
  viewMode: 'time' | 'frequency';
  onToggle: () => void;
  wsConnected: boolean;
}

const ModeToggle = ({ viewMode, onToggle, wsConnected }: ToggleProps) => (
  <button
    id="modal-view-toggle"
    onClick={onToggle}
    className={`
      flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium
      backdrop-blur-md transition-all duration-300 shadow-lg
      ${viewMode === 'time'
        ? 'bg-emerald-900/40 border-emerald-500/40 text-emerald-300 hover:bg-emerald-800/50'
        : 'bg-violet-900/40 border-violet-500/40 text-violet-300 hover:bg-violet-800/50'
      }
    `}
    title={viewMode === 'time'
      ? 'Cambiar a Modal Explorer (Dominio Frecuencial)'
      : 'Cambiar a Live Mirror (Dominio Temporal)'
    }
  >
    {viewMode === 'time' ? (
      <>
        <Clock className="w-4 h-4" />
        <span>Live Mirror</span>
        <div className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
      </>
    ) : (
      <>
        <BarChart2 className="w-4 h-4" />
        <span>Modal Explorer</span>
        <Radio className="w-3 h-3 opacity-60" />
      </>
    )}
  </button>
);

// ── Amplitude slider for Modal Explorer ───────────────────────────────────────

const AmplitudeSlider = () => {
  const amplitudeScale    = useModalStore((s) => s.amplitudeScale);
  const setAmplitudeScale = useModalStore((s) => s.setAmplitudeScale);

  return (
    <div className="flex items-center gap-2 bg-slate-900/70 backdrop-blur-md border border-slate-700/50 rounded-xl px-3 py-2">
      <Sliders className="w-3.5 h-3.5 text-violet-400 shrink-0" />
      <span className="text-xs text-slate-400 shrink-0">Amp. ×</span>
      <input
        id="amplitude-scale-slider"
        type="range"
        min={1}
        max={2000}
        step={1}
        value={amplitudeScale}
        onChange={(e) => setAmplitudeScale(Number(e.target.value))}
        className="w-24 accent-violet-500 cursor-pointer"
      />
      <span className="text-xs font-mono text-violet-300 w-12 shrink-0">
        {amplitudeScale}
      </span>
    </div>
  );
};

// ── Main exported component ────────────────────────────────────────────────────

export const FemMeshViewer = () => {
  const viewMode         = useModalStore((s) => s.viewMode);
  const setViewMode      = useModalStore((s) => s.setViewMode);
  const processMsg       = useModalStore((s) => s.processModalMessage);
  const loadFemShapes    = useModalStore((s) => s.loadFemShapes);
  const femShapesLoaded  = useModalStore((s) => s.femShapesLoaded);
  const femShapesError   = useModalStore((s) => s.femShapesError);
  const selectedModeId   = useModalStore((s) => s.selectedModeId);

  const [wsConnected, setWsConnected]       = useState(false);
  const [showSpectrum, setShowSpectrum]     = useState(false);
  const [statusMsg, setStatusMsg]           = useState('Conectando…');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load FEM mode shapes once ─────────────────────────────────────────────
  useEffect(() => {
    loadFemShapes();
  }, [loadFemShapes]);

  // ── WebSocket lifecycle ───────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (wsRef.current) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      setStatusMsg('Conectado');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ModalFilteredMessage;
        if (msg.type === 'modal_filtered') {
          // Always update spectrum; only update q_modal if in time mode
          // (frequency mode uses synthetic oscillation, not live q_modal)
          processMsg(msg);
        }
      } catch {/* ignore parse errors */}
    };

    ws.onclose = () => {
      wsRef.current = null;
      setWsConnected(false);
      setStatusMsg('Reconectando…');
      // Auto-reconnect after 2 s
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      setStatusMsg('Error WS — sin datos MQTT');
    };
  }, [processMsg]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    };
  }, [connect]);

  // ── Toggle handler ────────────────────────────────────────────────────────
  const handleToggle = useCallback(() => {
    const next = viewMode === 'time' ? 'frequency' : 'time';
    setViewMode(next);
    // Show spectrum panel automatically when switching to Modal Explorer
    if (next === 'frequency') setShowSpectrum(true);
  }, [viewMode, setViewMode]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-full relative flex flex-col bg-slate-950 rounded-lg overflow-hidden border border-slate-800">

      {/* ── Canvas ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        <Canvas shadows dpr={[1, 2]}>
          <color attach="background" args={['#020617']} />
          <fog attach="fog" args={['#020617', 15, 60]} />

          <PerspectiveCamera makeDefault position={[8, 6, 8]} fov={50} />
          <CameraControls />

          {/* Lighting */}
          <ambientLight intensity={0.7} />
          <directionalLight position={[10, 20, 10]} intensity={1.5} castShadow />
          <pointLight position={[-10, 10, -10]} intensity={0.5} color="#4f46e5" />

          {/* Modal mesh deformation controller */}
          <Suspense fallback={null}>
            {femShapesLoaded && <ModalMeshController />}
            <ContactShadows resolution={512} scale={30} blur={2} opacity={0.4} />
          </Suspense>

          <Grid
            infiniteGrid fadeDistance={40}
            sectionColor="#3b82f6" cellColor="#1e293b"
            sectionSize={5} cellSize={1}
            sectionThickness={1.2} cellThickness={0.4}
          />
          <Stars radius={100} depth={50} count={4000} factor={4} saturation={0} fade speed={1} />
          <Environment preset="city" />
        </Canvas>

        {/* ── Overlay: Mode toggle ─────────────────────────────────────────── */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
          <ModeToggle
            viewMode={viewMode}
            onToggle={handleToggle}
            wsConnected={wsConnected}
          />

          {/* Amplitude slider — only in Modal Explorer mode */}
          {viewMode === 'frequency' && <AmplitudeSlider />}

          {/* FEM loading state */}
          {!femShapesLoaded && !femShapesError && (
            <div className="text-xs text-slate-400 bg-slate-900/70 backdrop-blur-md border border-slate-700/50 rounded-lg px-3 py-2 flex items-center gap-1.5">
              <span className="animate-spin text-cyan-400">⟳</span>
              Cargando base modal FEM…
            </div>
          )}
          {femShapesError && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">
              ⚠ FEM: {femShapesError}
            </div>
          )}
        </div>

        {/* ── Overlay: Status bar ──────────────────────────────────────────── */}
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
          <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg backdrop-blur-md border
            ${wsConnected
              ? 'bg-emerald-900/40 border-emerald-700/40 text-emerald-300'
              : 'bg-slate-900/60 border-slate-700/40 text-slate-400'
            }`}
          >
            {wsConnected ? (
              <Activity className="w-3 h-3" />
            ) : (
              <ZapOff className="w-3 h-3" />
            )}
            <span>{statusMsg}</span>
          </div>

          {/* Mode label */}
          <div className="text-xs px-2 py-1 rounded-lg bg-slate-900/60 border border-slate-700/40 backdrop-blur-md text-slate-300">
            {viewMode === 'time'
              ? '∑ Φᵢ · qᵢ(t)'
              : selectedModeId
                ? `A·Φ_${selectedModeId}·sin(2π f_${selectedModeId} t)`
                : 'Selecciona un modo ↑'
            }
          </div>
        </div>

        {/* ── Overlay: Spectrum toggle button ──────────────────────────────── */}
        {viewMode === 'frequency' && (
          <button
            id="spectrum-panel-toggle"
            onClick={() => setShowSpectrum((v) => !v)}
            className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-slate-900/70 border border-slate-700/50 text-slate-300 hover:text-white backdrop-blur-md transition-all"
          >
            <BarChart2 className="w-3.5 h-3.5" />
            {showSpectrum ? 'Ocultar espectro' : 'Mostrar espectro'}
            {showSpectrum ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          </button>
        )}
      </div>

      {/* ── Spectrum panel (Modal Explorer) ──────────────────────────────────── */}
      {viewMode === 'frequency' && showSpectrum && (
        <div className="
          h-64 border-t border-slate-700/60 bg-slate-950/95 backdrop-blur-md
          p-4 flex flex-col
          animate-in slide-in-from-bottom-2 duration-200
        ">
          <SpectrumChart />
        </div>
      )}
    </div>
  );
};

export default FemMeshViewer;

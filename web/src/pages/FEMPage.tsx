import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ── Turbo colormap LUT ────────────────────────────────────────────────────────
const TURBO_LUT = (() => {
  const lut = new Float32Array(256 * 3);
  const r = (t: number) => Math.max(0, Math.min(1, 0.1357 + t * (4.5974 + t * (-42.3277 + t * (130.5887 + t * (-150.5666 + t * 58.1375))))));
  const g = (t: number) => Math.max(0, Math.min(1, 0.0914 + t * (2.1856 + t * (4.8052 + t * (-14.0741 + t * (4.2073 + t * 2.7249))))));
  const b = (t: number) => Math.max(0, Math.min(1, 0.1062 + t * (12.5925 + t * (-60.1097 + t * (109.0745 + t * (-88.5066 + t * 26.8183))))));
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    lut[i * 3] = r(t); lut[i * 3 + 1] = g(t); lut[i * 3 + 2] = b(t);
  }
  return lut;
})();

function colorTurbo(t: number): [number, number, number] {
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
  return [TURBO_LUT[i], TURBO_LUT[i + 1], TURBO_LUT[i + 2]];
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface ResData {
  modes: Record<string, Record<string, Record<string, [number, number, number]>>>;
}

type ColorComponent = 'magnitude' | 'x' | 'y' | 'z';
type PageTab = 'modal' | 'loads' | 'sim' | 'live';

interface LiveMatchedMode {
  mode_id: number;
  freq_hz: number;
  amplitude: number;
  normalized_amplitude: number;
}

interface LiveInfo {
  fps: number;
  nyquist_hz: number;
  n_samples: number;
  matched_modes: LiveMatchedMode[];
  timestamp: string;
}

// Find the GLB mode key for a given FEM mode number (tries common naming conventions)
function findModeKey(resData: ResData, modeId: number): string | null {
  const keys = Object.keys(resData.modes);
  const n = modeId;
  const pad3 = String(n).padStart(3, '0');
  return keys.find(k =>
    k === String(n) ||
    k === `Mode_${pad3}` ||
    k === `Mode_${n}` ||
    k === `mode_${n}` ||
    k === `MODE_${pad3}` ||
    k.endsWith(`_${n}`) ||
    k.startsWith(`Mode_${n}_`) ||   // matches "Mode_1_(Freq.:_0.7196)"
    k.startsWith(`mode_${n}_`)
  ) ?? null;
}

// Pre-calc simulation types
interface SimCase {
  id: string; name: string; type: 'wind' | 'wave';
  parameters: Record<string, number>; file: string;
}
interface CasesIndex { cases: SimCase[]; }
interface SimParams { mode: 'wind' | 'wave'; windSpeed: number; waveHs: number; waveTp: number; }

interface MqttPreset { label: string; topic: string; icon: string; description: string; }
const MQTT_PRESETS: MqttPreset[] = [
  { label: 'Wind', topic: 'oc4/wind', icon: '💨', description: 'windSpeed, windDirection (m/s, °)' },
  { label: 'Wave', topic: 'oc4/wave', icon: '🌊', description: 'waveHeight, wavePeriod (m, s)' },
  { label: 'Loads', topic: 'oc4/loads', icon: '⚙️', description: 'Fx,Fy,Fz,Mx,My,Mz (N, Nm)' },
];

interface State {
  mode1: string; mode2: string; mixAlpha: number;
  defScale: number; showDeform: boolean; colorBy: ColorComponent;
}

interface LoadCase {
  Fx: number; Fy: number; Fz: number;
  Mx: number; My: number; Mz: number;
  node_forces: Record<string, [number, number, number]>;
  source: string;
}

const ZERO_LOADS: LoadCase = { Fx: 0, Fy: 0, Fz: 0, Mx: 0, My: 0, Mz: 0, node_forces: {}, source: 'manual' };
const BACKEND_WS = 'ws://localhost:8080';

// ── Modal superposition ───────────────────────────────────────────────────────
function computeModalSuperposition(resData: ResData, vorderIds: number[], loads: LoadCase): Float32Array {
  const count = vorderIds.length;
  const result = new Float32Array(count * 3);
  const { Fx, Fy, Fz } = loads;
  const hasNodeForces = Object.keys(loads.node_forces).length > 0;

  for (const [, modeData] of Object.entries(resData.modes)) {
    const rk = Object.keys(modeData)[0];
    if (!rk) continue;
    const shapes = modeData[rk];
    let Q = 0, norm2 = 0;
    for (const [nid, phi] of Object.entries(shapes)) {
      if (hasNodeForces && loads.node_forces[nid]) {
        const nf = loads.node_forces[nid];
        Q += phi[0] * nf[0] + phi[1] * nf[1] + phi[2] * nf[2];
      } else {
        Q += phi[0] * Fx + phi[1] * Fy + phi[2] * Fz;
      }
      norm2 += phi[0] * phi[0] + phi[1] * phi[1] + phi[2] * phi[2];
    }
    if (norm2 === 0) continue;
    const alpha = Q / norm2;
    for (let vIdx = 0; vIdx < count; vIdx++) {
      const nid = String(vorderIds[vIdx]);
      const phi = shapes[nid];
      if (!phi) continue;
      result[vIdx * 3]     += alpha * phi[0];
      result[vIdx * 3 + 1] += alpha * phi[1];
      result[vIdx * 3 + 2] += alpha * phi[2];
    }
  }
  return result;
}

// ── Pre-calc sim helpers ──────────────────────────────────────────────────────
function parseSimResult(data: { displacements: Record<string, [number, number, number]> }): Float32Array {
  let maxId = 0;
  for (const k in data.displacements) {
    const id = parseInt(k);
    if (id > maxId) maxId = id;
  }
  const arr = new Float32Array((maxId + 1) * 3);
  for (const [k, v] of Object.entries(data.displacements)) {
    const id = parseInt(k);
    arr[id * 3] = v[0]; arr[id * 3 + 1] = v[1]; arr[id * 3 + 2] = v[2];
  }
  return arr;
}


function lerpArr(a: Float32Array, b: Float32Array, t: number): Float32Array {
  const n = Math.max(a.length, b.length);
  const c = new Float32Array(n);
  const minN = Math.min(a.length, b.length);
  for (let i = 0; i < minN; i++) c[i] = a[i] * (1 - t) + b[i] * t;
  return c;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function FEMPage() {
  const mountRef     = useRef<HTMLDivElement>(null);
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);
  const meshRef      = useRef<THREE.Mesh | null>(null);
  const basePosRef   = useRef<Float32Array | null>(null);
  const vorderRef    = useRef<number[] | null>(null);
  const resDataRef   = useRef<ResData | null>(null);
  const animFrameRef = useRef<number>(0);
  const stateRef     = useRef<State>({ mode1: '', mode2: '', mixAlpha: 0, defScale: 100, showDeform: true, colorBy: 'magnitude' });
  const pipelineWsRef = useRef<WebSocket | null>(null);

  // live modal refs
  const liveWsRef      = useRef<WebSocket | null>(null);
  const liveActiveRef  = useRef(false);

  // pre-calc sim refs
  const casesIndexRef  = useRef<CasesIndex | null>(null);
  const simResultsRef  = useRef<Record<string, Float32Array>>({});
  const simParamsRef   = useRef<SimParams>({ mode: 'wind', windSpeed: 5, waveHs: 1.0, waveTp: 10 });
  const simWsRef       = useRef<WebSocket | null>(null);
  const simActiveRef   = useRef(false);

  // scene objects visibility (all non-FEM meshes)
  const sceneObjectsRef = useRef<THREE.Mesh[]>([]);
  const [objVisible, setObjVisible]   = useState(true);
  const [objOpacity, setObjOpacity]   = useState(1.0);
  const [objPanelOpen, setObjPanelOpen] = useState(true);
  const [meshVisible, setMeshVisible] = useState(false);

  const [modes, setModes]       = useState<string[]>([]);
  const [loading, setLoading]   = useState(true);
  const [loadStatus, setLoadStatus] = useState('Initializing…');
  const [cbMin, setCbMin]       = useState('0.00e+0');
  const [cbMax, setCbMax]       = useState('1.00e+0');
  const [stats, setStats]       = useState({ vertices: 0, triangles: 0, numModes: 0, mapped: 0 });
  const [tab, setTab]           = useState<PageTab>('modal');
  const [uiState, setUiState]   = useState<State>({ mode1: '', mode2: '', mixAlpha: 0, defScale: 100, showDeform: true, colorBy: 'magnitude' });

  // loads tab state
  const [mqttConnected, setMqttConnected]   = useState(false);
  const [mqttStatus, setMqttStatus]         = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [mqttTopic, setMqttTopic]           = useState('oc4/wind');
  const [liveLoads, setLiveLoads]           = useState<LoadCase>(ZERO_LOADS);
  const [manualLoads, setManualLoads]       = useState<LoadCase>(ZERO_LOADS);
  const loadSimActiveRef                     = useRef(false);
  const currentLoadsRef                      = useRef<LoadCase>(ZERO_LOADS);

  // live modal tab state
  const [liveStatus, setLiveStatus]         = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [liveInfo, setLiveInfo]             = useState<LiveInfo | null>(null);

  // sim tab state
  const [simParams, _setSimParams]          = useState<SimParams>({ mode: 'wind', windSpeed: 5, waveHs: 1.0, waveTp: 10 });
  const [simWsConnected, setSimWsConnected] = useState(false);
  const [simCaseLoading, setSimCaseLoading] = useState(false);
  const [casesLoaded, setCasesLoaded]       = useState(false);

  const setSimParams = useCallback((updater: SimParams | ((p: SimParams) => SimParams)) => {
    _setSimParams(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      simParamsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => { currentLoadsRef.current = mqttConnected ? liveLoads : manualLoads; }, [mqttConnected, liveLoads, manualLoads]);
  useEffect(() => { stateRef.current = uiState; }, [uiState]);

  // ── Core paint: modal + loads ──────────────────────────────────────────────
  const applyUpdate = useCallback((forceLoads?: LoadCase) => {
    const mesh = meshRef.current;
    const resData = resDataRef.current;
    const vorderIds = vorderRef.current;
    const basePos = basePosRef.current;
    if (!mesh || !resData || !vorderIds || !basePos) return;

    const geo = mesh.geometry;
    const count = geo.attributes.position.count;
    const state = stateRef.current;

    if (!geo.attributes.color) {
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    }

    const colorArr = geo.attributes.color.array as Float32Array;
    const pos = geo.attributes.position.array as Float32Array;
    const scalars = new Float32Array(count);
    let minVal = Infinity, maxVal = -Infinity;

    if (loadSimActiveRef.current) {
      const loads = forceLoads ?? currentLoadsRef.current;
      const values = computeModalSuperposition(resData, vorderIds, loads);
      for (let vIdx = 0; vIdx < count; vIdx++) {
        const dx = values[vIdx * 3], dy = values[vIdx * 3 + 1], dz = values[vIdx * 3 + 2];
        let scalar: number;
        if (state.colorBy === 'x') scalar = Math.abs(dx);
        else if (state.colorBy === 'y') scalar = Math.abs(dy);
        else if (state.colorBy === 'z') scalar = Math.abs(dz);
        else scalar = Math.sqrt(dx * dx + dy * dy + dz * dz);
        scalars[vIdx] = scalar;
        if (scalar < minVal) minVal = scalar;
        if (scalar > maxVal) maxVal = scalar;
      }
      const range = maxVal - minVal || 1;
      for (let i = 0; i < count; i++) {
        const t = (scalars[i] - minVal) / range;
        const [r, g, b] = colorTurbo(t);
        colorArr[i * 3] = r; colorArr[i * 3 + 1] = g; colorArr[i * 3 + 2] = b;
      }
      const s = state.showDeform ? state.defScale * 0.00005 : 0;
      for (let i = 0; i < count; i++) {
        pos[i * 3]     = basePos[i * 3]     + values[i * 3]     * s;
        pos[i * 3 + 1] = basePos[i * 3 + 1] + values[i * 3 + 1] * s;
        pos[i * 3 + 2] = basePos[i * 3 + 2] + values[i * 3 + 2] * s;
      }
    } else {
      const m1 = state.mode1 ? resData.modes[state.mode1] : null;
      const m2 = state.mode2 && state.mode2 !== '__none__' ? resData.modes[state.mode2] : null;
      const rk1 = m1 ? Object.keys(m1)[0] : null;
      const rk2 = m2 ? Object.keys(m2)[0] : null;
      const values = new Float32Array(count * 3);

      for (let vIdx = 0; vIdx < count; vIdx++) {
        const nid = String(vorderIds[vIdx]);
        let dx = 0, dy = 0, dz = 0;
        if (m1 && rk1) { const v = m1[rk1][nid]; if (v) { dx = v[0] || 0; dy = v[1] || 0; dz = v[2] || 0; } }
        if (m2 && rk2 && state.mixAlpha > 0) {
          const v = m2[rk2][nid];
          if (v) {
            const alpha = state.mixAlpha / 100;
            dx = dx * (1 - alpha) + (v[0] || 0) * alpha;
            dy = dy * (1 - alpha) + (v[1] || 0) * alpha;
            dz = dz * (1 - alpha) + (v[2] || 0) * alpha;
          }
        }
        values[vIdx * 3] = dx; values[vIdx * 3 + 1] = dy; values[vIdx * 3 + 2] = dz;
        let scalar: number;
        if (state.colorBy === 'x') scalar = Math.abs(dx);
        else if (state.colorBy === 'y') scalar = Math.abs(dy);
        else if (state.colorBy === 'z') scalar = Math.abs(dz);
        else scalar = Math.sqrt(dx * dx + dy * dy + dz * dz);
        scalars[vIdx] = scalar;
        if (scalar < minVal) minVal = scalar;
        if (scalar > maxVal) maxVal = scalar;
      }
      const range = maxVal - minVal || 1;
      for (let i = 0; i < count; i++) {
        const t = (scalars[i] - minVal) / range;
        const [r, g, b] = colorTurbo(t);
        colorArr[i * 3] = r; colorArr[i * 3 + 1] = g; colorArr[i * 3 + 2] = b;
      }
      const s = state.showDeform ? state.defScale * 0.00005 : 0;
      for (let i = 0; i < count; i++) {
        pos[i * 3]     = basePos[i * 3]     + values[i * 3]     * s;
        pos[i * 3 + 1] = basePos[i * 3 + 1] + values[i * 3 + 1] * s;
        pos[i * 3 + 2] = basePos[i * 3 + 2] + values[i * 3 + 2] * s;
      }
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
    setCbMin(isFinite(minVal) ? minVal.toExponential(2) : '0.00e+0');
    setCbMax(isFinite(maxVal) ? maxVal.toExponential(2) : '1.00e+0');
  }, []);

  // ── Pre-calc sim: apply displacement from result array ────────────────────
  const applySimUpdate = useCallback(() => {
    const mesh = meshRef.current;
    const basePos = basePosRef.current;
    const vorderIds = vorderRef.current;
    const index = casesIndexRef.current;
    if (!mesh || !basePos || !vorderIds || !index) return;

    const params = simParamsRef.current;
    const state = stateRef.current;

    // Build displacement array via interpolation
    let dispArr: Float32Array | null = null;

    if (params.mode === 'wind') {
      const windCases = index.cases
        .filter(c => c.type === 'wind')
        .map(c => ({ U: c.parameters.U_ms, arr: simResultsRef.current[c.id] }))
        .filter(x => x.arr)
        .sort((a, b) => a.U - b.U);

      if (windCases.length > 0) {
        const U = params.windSpeed;
        if (windCases.length === 1 || U <= windCases[0].U) {
          // Scale by (U/U_ref)^2 below lower bound
          const ref = windCases[0];
          const scale = ref.U > 0 ? (U / ref.U) ** 2 : 1;
          dispArr = new Float32Array(ref.arr!.length);
          for (let i = 0; i < dispArr.length; i++) dispArr[i] = ref.arr![i] * scale;
        } else if (U >= windCases[windCases.length - 1].U) {
          const ref = windCases[windCases.length - 1];
          const scale = ref.U > 0 ? (U / ref.U) ** 2 : 1;
          dispArr = new Float32Array(ref.arr!.length);
          for (let i = 0; i < dispArr.length; i++) dispArr[i] = ref.arr![i] * scale;
        } else {
          for (let i = 0; i < windCases.length - 1; i++) {
            if (U >= windCases[i].U && U <= windCases[i + 1].U) {
              const t = (U - windCases[i].U) / (windCases[i + 1].U - windCases[i].U);
              dispArr = lerpArr(windCases[i].arr!, windCases[i + 1].arr!, t);
              break;
            }
          }
        }
      }
    } else {
      // Wave: nearest neighbour by Hs
      const waveCases = index.cases
        .filter(c => c.type === 'wave')
        .map(c => ({ Hs: c.parameters.Hs_m, arr: simResultsRef.current[c.id] }))
        .filter(x => x.arr);

      if (waveCases.length > 0) {
        let nearest = waveCases[0];
        let minDist = Math.abs(params.waveHs - waveCases[0].Hs);
        for (const c of waveCases) {
          const d = Math.abs(params.waveHs - c.Hs);
          if (d < minDist) { minDist = d; nearest = c; }
        }
        dispArr = nearest.arr!;
      }
    }

    if (!dispArr) return;

    const geo = mesh.geometry;
    const count = geo.attributes.position.count;

    if (!geo.attributes.color) {
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    }

    const colorArr = geo.attributes.color.array as Float32Array;
    const pos = geo.attributes.position.array as Float32Array;
    const scalars = new Float32Array(count);
    let minVal = Infinity, maxVal = -Infinity;

    for (let vIdx = 0; vIdx < count; vIdx++) {
      const nid = vorderIds[vIdx];
      const base = nid * 3;
      if (base + 2 < dispArr.length) {
        const dx = dispArr[base], dy = dispArr[base + 1], dz = dispArr[base + 2];
        let s: number;
        if (state.colorBy === 'x') s = Math.abs(dx);
        else if (state.colorBy === 'y') s = Math.abs(dy);
        else if (state.colorBy === 'z') s = Math.abs(dz);
        else s = Math.sqrt(dx * dx + dy * dy + dz * dz);
        scalars[vIdx] = s;
        if (s < minVal) minVal = s;
        if (s > maxVal) maxVal = s;
      }
    }

    const range = maxVal - minVal || 1;
    for (let i = 0; i < count; i++) {
      const t = (scalars[i] - minVal) / range;
      const [r, g, b] = colorTurbo(t);
      colorArr[i * 3] = r; colorArr[i * 3 + 1] = g; colorArr[i * 3 + 2] = b;
    }

    // displacements are normalized to max=1; scale factor makes deformations visible
    const s = state.showDeform ? state.defScale * 0.001 : 0;
    for (let i = 0; i < count; i++) {
      const nid = vorderIds[i];
      const base = nid * 3;
      if (base + 2 < dispArr.length) {
        pos[i * 3]     = basePos[i * 3]     + dispArr[base]     * s;
        pos[i * 3 + 1] = basePos[i * 3 + 1] + dispArr[base + 1] * s;
        pos[i * 3 + 2] = basePos[i * 3 + 2] + dispArr[base + 2] * s;
      } else {
        pos[i * 3] = basePos[i * 3]; pos[i * 3 + 1] = basePos[i * 3 + 1]; pos[i * 3 + 2] = basePos[i * 3 + 2];
      }
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
    setCbMin(isFinite(minVal) ? minVal.toExponential(2) : '0.00e+0');
    setCbMax(isFinite(maxVal) ? maxVal.toExponential(2) : '1.00e+0');
  }, []);

  // Lazy-load needed result files, then render
  const loadAndApplySimUpdate = useCallback(async (params: SimParams) => {
    const index = casesIndexRef.current;
    if (!index) return;

    const neededCases = index.cases.filter(c => c.type === params.mode);
    const rawKey = (id: string) => `${id}_raw`;
    const toLoad = neededCases.filter(c => !simResultsRef.current[rawKey(c.id)]);

    if (toLoad.length > 0) {
      setSimCaseLoading(true);
      try {
        await Promise.all(toLoad.map(async c => {
          const resp = await fetch(`/simulation_results/${c.file}`);
          const data = await resp.json();
          simResultsRef.current[rawKey(c.id)] = parseSimResult(data);
        }));
      } finally {
        setSimCaseLoading(false);
      }
    }

    // Cross-normalize all cases of this type by their shared global max
    // so different load levels produce different colors
    const allCases = index.cases.filter(c => c.type === params.mode);
    const allLoaded = allCases.every(c => simResultsRef.current[rawKey(c.id)]);
    if (allLoaded) {
      let globalMaxSq = 0;
      for (const c of allCases) {
        const arr = simResultsRef.current[rawKey(c.id)];
        for (let i = 0; i < arr.length; i += 3) {
          const m = arr[i] * arr[i] + arr[i + 1] * arr[i + 1] + arr[i + 2] * arr[i + 2];
          if (m > globalMaxSq) globalMaxSq = m;
        }
      }
      const inv = globalMaxSq > 0 ? 1 / Math.sqrt(globalMaxSq) : 1;
      for (const c of allCases) {
        const raw = simResultsRef.current[rawKey(c.id)];
        const norm = new Float32Array(raw.length);
        for (let i = 0; i < raw.length; i++) norm[i] = raw[i] * inv;
        simResultsRef.current[c.id] = norm;
      }
    }

    if (simActiveRef.current) applySimUpdate();
  }, [applySimUpdate]);

  // ── Three.js init + asset loading ──────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a14);

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.1, 10000);
    camera.position.set(0, 100, 300);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.07;

    scene.add(new THREE.AmbientLight(0xffffff, 3.0));
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight1.position.set(1, 2, 2);
    scene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight2.position.set(-1, -2, -2);
    scene.add(dirLight2);

    const onResize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener('resize', onResize);

    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    async function loadAll() {
      try {
        setLoadStatus('Loading vertex order…');
        const vorderResp = await fetch('/OC4-modal/OC4-modal_vorder.json');
        const vorderData = await vorderResp.json();
        vorderRef.current = vorderData.nodeIds as number[];

        setLoadStatus('Loading 3D model…');
        const loader = new GLTFLoader();
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
          loader.load('/models/OC4-modal.glb', resolve, undefined, reject)
        );

        let targetMesh: THREE.Mesh | null = null;
        let maxVerts = 0;
        gltf.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            if (obj.name === 'OC4_Structure') { targetMesh = obj; }
            else if (!targetMesh) {
              const cnt = obj.geometry.attributes.position?.count ?? 0;
              if (cnt > maxVerts) { maxVerts = cnt; targetMesh = obj; }
            }
          }
        });

        if (!targetMesh) throw new Error('No mesh found in GLB');
        const mesh = targetMesh as THREE.Mesh;
        mesh.material = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 30 });
        basePosRef.current = (mesh.geometry.attributes.position.array as Float32Array).slice();
        mesh.visible = false;
        meshRef.current = mesh;
        scene.add(gltf.scene);

        // Collect all other meshes (not the FEM mesh) for visibility control
        const others: THREE.Mesh[] = [];
        gltf.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh && obj !== mesh) {
            // Clone material so we can change opacity independently
            if (!Array.isArray(obj.material)) {
              obj.material = obj.material.clone();
              (obj.material as THREE.MeshStandardMaterial).transparent = true;
            }
            others.push(obj);
          }
        });
        sceneObjectsRef.current = others;

        const box = new THREE.Box3().setFromObject(gltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        controls.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(0, size * 0.3, size * 0.8));
        controls.update();

        const vCnt = mesh.geometry.attributes.position.count;
        const tCnt = (mesh.geometry.index ? mesh.geometry.index.count : vCnt) / 3;

        setLoadStatus('Loading modal results…');
        const resResp = await fetch('/OC4-modal/OC4-modal_res.json');
        const resData: ResData = await resResp.json();
        resDataRef.current = resData;

        const modeKeys = Object.keys(resData.modes);
        setModes(modeKeys);

        const firstMode = modeKeys[0] ?? '';
        const newState: State = { ...stateRef.current, mode1: firstMode, mode2: '__none__' };
        stateRef.current = newState;
        setUiState(newState);

        const uniqueNodes = new Set(vorderRef.current ?? []);
        const firstModeData = resData.modes[firstMode];
        const firstResultKey = firstModeData ? Object.keys(firstModeData)[0] : null;
        const mappedCount = firstResultKey
          ? [...uniqueNodes].filter(id => firstModeData[firstResultKey][String(id)]).length
          : 0;

        setStats({ vertices: vCnt, triangles: Math.round(tCnt), numModes: modeKeys.length, mapped: mappedCount });

        // Load simulation cases index
        setLoadStatus('Loading simulation index…');
        try {
          const indexResp = await fetch('/simulation_results/cases_index.json');
          if (indexResp.ok) {
            casesIndexRef.current = await indexResp.json();
            setCasesLoaded(true);
          }
        } catch { /* non-fatal */ }

        setLoading(false);
        applyUpdate();
      } catch (err) {
        setLoadStatus(`Error: ${(err as Error).message}`);
      }
    }

    loadAll();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, [applyUpdate]);

  useEffect(() => {
    if (!loading && !loadSimActiveRef.current && !simActiveRef.current) applyUpdate();
  }, [uiState, loading, applyUpdate]);

  // ── MQTT bridge ────────────────────────────────────────────────────────────
  const connectMqtt = useCallback((topic: string) => {
    if (pipelineWsRef.current) { pipelineWsRef.current.close(); pipelineWsRef.current = null; }
    setMqttStatus('connecting');
    const ws = new WebSocket(`${BACKEND_WS}/api/fem/mqtt-ws?topic=${encodeURIComponent(topic)}`);
    pipelineWsRef.current = ws;
    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === 'connected') { setMqttStatus('connected'); setMqttConnected(true); loadSimActiveRef.current = true; return; }
        if (data.type === 'error') { setMqttStatus('error'); return; }
        const loads = data as LoadCase;
        setLiveLoads(loads); currentLoadsRef.current = loads; applyUpdate(loads);
      } catch { /* ignore */ }
    };
    ws.onerror = () => setMqttStatus('error');
    ws.onclose = () => { setMqttStatus('idle'); setMqttConnected(false); };
  }, [applyUpdate]);

  const disconnectMqtt = useCallback(() => {
    pipelineWsRef.current?.close(); pipelineWsRef.current = null;
    setMqttConnected(false); setMqttStatus('idle');
    loadSimActiveRef.current = false; applyUpdate();
  }, [applyUpdate]);

  useEffect(() => () => { pipelineWsRef.current?.close(); }, []);

  useEffect(() => {
    if (!loading && loadSimActiveRef.current && !mqttConnected) applyUpdate(manualLoads);
  }, [manualLoads, loading, mqttConnected, applyUpdate]);

  // ── Scene object visibility ────────────────────────────────────────────────
  useEffect(() => {
    for (const obj of sceneObjectsRef.current) {
      obj.visible = objVisible;
      if (!Array.isArray(obj.material)) {
        (obj.material as THREE.MeshStandardMaterial).opacity = objOpacity;
      }
    }
  }, [objVisible, objOpacity]);

  useEffect(() => {
    if (meshRef.current) meshRef.current.visible = meshVisible;
  }, [meshVisible]);

  // ── Sim WS (node editor → FEM page) ───────────────────────────────────────
  const connectSimWs = useCallback(() => {
    if (simWsRef.current) simWsRef.current.close();
    const ws = new WebSocket(`${BACKEND_WS}/api/fem/sim-ws`);
    simWsRef.current = ws;
    ws.onopen = () => setSimWsConnected(true);
    ws.onmessage = (evt) => {
      try {
        const params = JSON.parse(evt.data) as SimParams;
        setSimParams(params);
        if (simActiveRef.current) loadAndApplySimUpdate(params);
      } catch { /* ignore */ }
    };
    ws.onclose = () => setSimWsConnected(false);
    ws.onerror = () => setSimWsConnected(false);
  }, [setSimParams, loadAndApplySimUpdate]);

  const disconnectSimWs = useCallback(() => {
    simWsRef.current?.close(); simWsRef.current = null;
    setSimWsConnected(false);
  }, []);

  useEffect(() => () => { simWsRef.current?.close(); }, []);

  // Re-render when sim params change while sim tab is active
  useEffect(() => {
    if (!loading && simActiveRef.current) loadAndApplySimUpdate(simParams);
  }, [simParams, loading, loadAndApplySimUpdate]);

  // ── Live modal: apply FFT modal amplitudes to mesh ─────────────────────────
  const applyLiveModal = useCallback((matchedModes: LiveMatchedMode[]) => {
    const mesh     = meshRef.current;
    const resData  = resDataRef.current;
    const vorderIds = vorderRef.current;
    const basePos  = basePosRef.current;
    if (!mesh || !resData || !vorderIds || !basePos) return;

    const geo   = mesh.geometry;
    const count = geo.attributes.position.count;
    const state = stateRef.current;

    if (!geo.attributes.color) {
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    }

    const colorArr = geo.attributes.color.array as Float32Array;
    const pos      = geo.attributes.position.array as Float32Array;
    const values   = new Float32Array(count * 3);
    const scalars  = new Float32Array(count);
    let minVal = Infinity, maxVal = -Infinity;

    // Sum normalised modal contributions
    for (const { mode_id, normalized_amplitude } of matchedModes) {
      const modeKey = findModeKey(resData, mode_id);
      if (!modeKey) continue;
      const modeData = resData.modes[modeKey];
      const rk = Object.keys(modeData)[0];
      if (!rk) continue;
      const shapes = modeData[rk];
      for (let vIdx = 0; vIdx < count; vIdx++) {
        const phi = shapes[String(vorderIds[vIdx])];
        if (!phi) continue;
        values[vIdx * 3]     += normalized_amplitude * (phi[0] || 0);
        values[vIdx * 3 + 1] += normalized_amplitude * (phi[1] || 0);
        values[vIdx * 3 + 2] += normalized_amplitude * (phi[2] || 0);
      }
    }

    for (let vIdx = 0; vIdx < count; vIdx++) {
      const dx = values[vIdx * 3], dy = values[vIdx * 3 + 1], dz = values[vIdx * 3 + 2];
      let scalar: number;
      if (state.colorBy === 'x') scalar = Math.abs(dx);
      else if (state.colorBy === 'y') scalar = Math.abs(dy);
      else if (state.colorBy === 'z') scalar = Math.abs(dz);
      else scalar = Math.sqrt(dx * dx + dy * dy + dz * dz);
      scalars[vIdx] = scalar;
      if (scalar < minVal) minVal = scalar;
      if (scalar > maxVal) maxVal = scalar;
    }

    const range = maxVal - minVal || 1;
    for (let i = 0; i < count; i++) {
      const t = (scalars[i] - minVal) / range;
      const [r, g, b] = colorTurbo(t);
      colorArr[i * 3] = r; colorArr[i * 3 + 1] = g; colorArr[i * 3 + 2] = b;
    }

    const s = state.showDeform ? state.defScale * 0.00005 : 0;
    for (let i = 0; i < count; i++) {
      pos[i * 3]     = basePos[i * 3]     + values[i * 3]     * s;
      pos[i * 3 + 1] = basePos[i * 3 + 1] + values[i * 3 + 1] * s;
      pos[i * 3 + 2] = basePos[i * 3 + 2] + values[i * 3 + 2] * s;
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate    = true;
    geo.computeVertexNormals();
    setCbMin(isFinite(minVal) ? minVal.toExponential(2) : '0.00e+0');
    setCbMax(isFinite(maxVal) ? maxVal.toExponential(2) : '1.00e+0');
  }, []);

  // ── Live modal: WebSocket connect / disconnect ─────────────────────────────
  const connectLiveModal = useCallback(async () => {
    liveWsRef.current?.close();
    setLiveStatus('connecting');
    setLiveInfo(null);

    // Launch signal_processing.py on the backend
    try {
      await fetch('http://localhost:8080/api/fem/live-scripts/start', { method: 'POST' });
    } catch { /* non-fatal: backend may already have it running or be unreachable */ }

    // Show the FEM mesh so the coloring is visible
    if (meshRef.current) meshRef.current.visible = true;
    setMeshVisible(true);

    const ws = new WebSocket(`${BACKEND_WS}/api/fem/modal-live-ws`);
    liveWsRef.current = ws;
    liveActiveRef.current = true;   // re-arm after close() above may have reset it

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === 'connected') { setLiveStatus('connected'); return; }
        if (data.type === 'error')     { setLiveStatus('error');     return; }
        if (data.type === 'modal_update' && liveActiveRef.current) {
          setLiveInfo(data as LiveInfo);
          applyLiveModal((data as LiveInfo).matched_modes);
        }
      } catch { /* ignore malformed frames */ }
    };
    ws.onerror = () => setLiveStatus('error');
    ws.onclose = () => { setLiveStatus('idle'); liveActiveRef.current = false; };
  }, [applyLiveModal]);

  const disconnectLiveModal = useCallback(async () => {
    liveWsRef.current?.close();
    liveWsRef.current   = null;
    liveActiveRef.current = false;
    setLiveStatus('idle');
    setLiveInfo(null);
    applyLiveModal([]);   // reset mesh to neutral

    // Stop signal_processing.py
    try {
      await fetch('http://localhost:8080/api/fem/live-scripts/stop', { method: 'POST' });
    } catch { /* non-fatal */ }
  }, [applyLiveModal]);

  useEffect(() => () => { liveWsRef.current?.close(); }, []);

  // ── Tab switch ─────────────────────────────────────────────────────────────
  const switchTab = useCallback((t: PageTab) => {
    setTab(t);
    // Deactivate previous tab modes
    loadSimActiveRef.current = false;
    simActiveRef.current     = false;
    liveActiveRef.current    = false;

    if (t === 'sim') {
      simActiveRef.current = true;
      loadAndApplySimUpdate(simParamsRef.current);
    } else if (t === 'loads') {
      loadSimActiveRef.current = true;
      applyUpdate(currentLoadsRef.current);
    } else if (t === 'live') {
      liveActiveRef.current = true;
      // keep whatever was last painted; user clicks Connect to start streaming
    } else {
      applyUpdate();
    }
  }, [applyUpdate, loadAndApplySimUpdate]);

  const setField = <K extends keyof State>(key: K, value: State[K]) =>
    setUiState(prev => ({ ...prev, [key]: value }));

  const setLoad = (key: keyof LoadCase, value: number) =>
    setManualLoads(prev => ({ ...prev, [key]: value }));


  // ── Render ─────────────────────────────────────────────────────────────────
  const statusColor = { idle: '#556', connecting: '#f59e0b', connected: '#10b981', error: '#ef4444' }[mqttStatus];

  return (
    <div style={{ display: 'flex', height: '100%', margin: '-1.5rem', overflow: 'hidden', background: '#0a0a14' }}>
      {/* ── Left panel ── */}
      <div style={{
        width: 290, minWidth: 290, background: '#10101e', borderRight: '1px solid #1e2035',
        display: 'flex', flexDirection: 'column', overflowY: 'auto', color: '#e0e6f0', fontSize: 13,
      }}>
        <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #1e2035' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#7eb8f7', letterSpacing: 0.5 }}>FEM Modal Analysis</h2>
          <p style={{ margin: '3px 0 0', fontSize: 11, color: '#556' }}>OC4 Semi-submersible</p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #1e2035' }}>
          {([
            { id: 'modal', label: '⬡ Modal' },
            { id: 'loads', label: '⚡ Loads' },
            { id: 'sim',   label: '🌊 Sim' },
            { id: 'live',  label: '📡 Live' },
          ] as { id: PageTab; label: string }[]).map(({ id, label }) => (
            <button key={id} onClick={() => switchTab(id)} style={{
              flex: 1, padding: '8px 2px', fontSize: 10, fontWeight: 600, border: 'none', cursor: 'pointer',
              textTransform: 'uppercase', letterSpacing: 0.5,
              background: tab === id ? '#1a1a30' : 'transparent',
              color: tab === id ? '#7eb8f7' : '#556',
              borderBottom: tab === id ? '2px solid #7eb8f7' : '2px solid transparent',
            }}>{label}</button>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 20, color: '#7eb8f7', fontSize: 12 }}>{loadStatus}</div>
        ) : tab === 'modal' ? (
          /* ── Modal shapes tab ──────────────────────────────────────────── */
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>Mode 1</span>
              <select value={uiState.mode1} onChange={e => setField('mode1', e.target.value)} style={selectStyle}>
                {modes.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>Mode 2 (interpolation)</span>
              <select value={uiState.mode2} onChange={e => setField('mode2', e.target.value)} style={selectStyle}>
                <option value="__none__">None</option>
                {modes.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>Mix: {uiState.mixAlpha}%</span>
              <input type="range" min={0} max={100} value={uiState.mixAlpha}
                onChange={e => setField('mixAlpha', Number(e.target.value))}
                style={{ accentColor: '#7eb8f7', width: '100%' }} />
            </label>
            <Divider />
            <SharedControls uiState={uiState} setField={setField} cbMin={cbMin} cbMax={cbMax} />
            <Divider />
            <StatsPanel stats={stats} />
          </div>

        ) : tab === 'loads' ? (
          /* ── Load simulation tab ───────────────────────────────────────── */
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: '#0e0e20', borderRadius: 8, border: '1px solid #1e2035', padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 14 }}>📡</span>
                <span style={{ fontWeight: 700, color: '#cde', fontSize: 12 }}>MQTT Source</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: statusColor, fontWeight: 600 }}>● {mqttStatus.toUpperCase()}</span>
              </div>
              <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
                {MQTT_PRESETS.map(p => (
                  <button key={p.topic} onClick={() => !mqttConnected && setMqttTopic(p.topic)} title={p.description} style={{
                    flex: 1, padding: '5px 4px', borderRadius: 6, border: '1px solid',
                    fontSize: 10, fontWeight: 700, cursor: mqttConnected ? 'default' : 'pointer',
                    borderColor: mqttTopic === p.topic ? '#7eb8f7' : '#1e2035',
                    background: mqttTopic === p.topic ? '#0d2035' : '#181828',
                    color: mqttTopic === p.topic ? '#7eb8f7' : '#556',
                  }}>{p.icon} {p.label}</button>
                ))}
              </div>
              <div style={{ marginBottom: 10 }}>
                <span style={{ ...labelStyle, display: 'block', marginBottom: 4 }}>Topic</span>
                <input type="text" value={mqttTopic} disabled={mqttConnected} onChange={e => setMqttTopic(e.target.value)}
                  placeholder="oc4/wind" style={{ ...selectStyle, opacity: mqttConnected ? 0.5 : 1 }} />
              </div>
              <button onClick={mqttConnected ? disconnectMqtt : () => connectMqtt(mqttTopic)} disabled={mqttStatus === 'connecting'}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 700,
                  background: mqttConnected ? '#2d1010' : '#0d2035',
                  color: mqttConnected ? '#ef4444' : '#7eb8f7' }}>
                {mqttConnected ? '⏹ Disconnect' : mqttStatus === 'connecting' ? 'Connecting…' : '▶ Connect'}
              </button>
              {mqttConnected && (
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {(['Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz'] as (keyof LoadCase)[]).map(k => (
                    <div key={k as string} style={{ background: '#181828', borderRadius: 4, padding: '4px 8px' }}>
                      <span style={{ color: '#556', fontSize: 10 }}>{k as string}</span>
                      <div style={{ color: '#7eb8f7', fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
                        {(typeof liveLoads[k] === 'number' ? (liveLoads[k] as number).toExponential(2) : '—')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ opacity: mqttConnected ? 0.4 : 1, pointerEvents: mqttConnected ? 'none' : 'auto' }}>
              <span style={labelStyle}>Manual load case (N / Nm)</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                {(['Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz'] as (keyof LoadCase)[]).map(k => (
                  <label key={k as string} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ color: '#9ab', fontSize: 10 }}>{k as string}</span>
                    <input type="number" step={100} value={manualLoads[k] as number}
                      onChange={e => setLoad(k, Number(e.target.value))}
                      style={{ ...selectStyle, fontSize: 12, padding: '4px 6px' }} />
                  </label>
                ))}
              </div>
              <button onClick={() => setManualLoads(ZERO_LOADS)}
                style={{ marginTop: 8, width: '100%', padding: '5px', borderRadius: 6, border: '1px solid #1e2035',
                  background: '#181828', color: '#9ab', fontSize: 11, cursor: 'pointer' }}>
                Reset loads
              </button>
            </div>

            <Divider />
            <SharedControls uiState={uiState} setField={setField} cbMin={cbMin} cbMax={cbMax} />
          </div>

        ) : tab === 'sim' ? (
          /* ── Pre-calc Simulation tab ───────────────────────────────────── */
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Node editor WS */}
            <div style={{ background: '#0e0e20', borderRadius: 8, border: '1px solid #1e2035', padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13 }}>🏗️</span>
                <span style={{ fontWeight: 700, color: '#cde', fontSize: 12 }}>Node Editor</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                  color: simWsConnected ? '#10b981' : '#556' }}>
                  ● {simWsConnected ? 'LIVE' : 'MANUAL'}
                </span>
              </div>
              <p style={{ margin: '0 0 8px', fontSize: 10, color: '#556', lineHeight: 1.4 }}>
                Add a <strong style={{ color: '#9ab' }}>FEM Sim Viewer</strong> node in the node editor to control this view live.
              </p>
              <button onClick={simWsConnected ? disconnectSimWs : connectSimWs} style={{
                width: '100%', padding: '6px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 700,
                background: simWsConnected ? '#2d1010' : '#0d2035',
                color: simWsConnected ? '#ef4444' : '#7eb8f7',
              }}>
                {simWsConnected ? '⏹ Disconnect' : '▶ Connect to node editor'}
              </button>
            </div>

            {/* Mode selector */}
            <div>
              <span style={labelStyle}>Load type</span>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {(['wind', 'wave'] as const).map(m => (
                  <button key={m} onClick={() => {
                    setSimParams(p => ({ ...p, mode: m }));
                  }} style={{
                    flex: 1, padding: '7px', borderRadius: 6, border: '1px solid',
                    fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    borderColor: simParams.mode === m ? '#7eb8f7' : '#1e2035',
                    background: simParams.mode === m ? '#0d2035' : '#181828',
                    color: simParams.mode === m ? '#7eb8f7' : '#556',
                  }}>
                    {m === 'wind' ? '💨 Wind' : '🌊 Wave'}
                  </button>
                ))}
              </div>
            </div>

            {/* Wind controls */}
            {simParams.mode === 'wind' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={labelStyle}>Wind speed</span>
                    <span style={{ color: '#7eb8f7', fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
                      {simParams.windSpeed.toFixed(1)} m/s
                    </span>
                  </div>
                  <input type="range" min={0} max={15} step={0.1} value={simParams.windSpeed}
                    onChange={e => setSimParams(p => ({ ...p, windSpeed: Number(e.target.value) }))}
                    style={{ accentColor: '#7eb8f7', width: '100%' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#445' }}>
                    <span>0 m/s</span><span>ref: 3 · 5 · 8</span><span>15 m/s</span>
                  </div>
                </label>
              </div>
            )}

            {/* Wave controls */}
            {simParams.mode === 'wave' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={labelStyle}>Sig. wave height Hs</span>
                    <span style={{ color: '#7eb8f7', fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
                      {simParams.waveHs.toFixed(2)} m
                    </span>
                  </div>
                  <input type="range" min={0.1} max={3.0} step={0.05} value={simParams.waveHs}
                    onChange={e => setSimParams(p => ({ ...p, waveHs: Number(e.target.value) }))}
                    style={{ accentColor: '#38bdf8', width: '100%' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#445' }}>
                    <span>0.1 m</span><span>ref: 0.5 · 1.0 · 2.0</span><span>3.0 m</span>
                  </div>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={labelStyle}>Peak period Tp</span>
                    <span style={{ color: '#38bdf8', fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
                      {simParams.waveTp.toFixed(1)} s
                    </span>
                  </div>
                  <input type="range" min={5} max={20} step={0.5} value={simParams.waveTp}
                    onChange={e => setSimParams(p => ({ ...p, waveTp: Number(e.target.value) }))}
                    style={{ accentColor: '#38bdf8', width: '100%' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#445' }}>
                    <span>5 s</span><span>ref: 8 · 10 · 12</span><span>20 s</span>
                  </div>
                </label>
                <p style={{ margin: 0, fontSize: 10, color: '#445' }}>
                  Nearest pre-calculated case selected by Hs.
                </p>
              </div>
            )}

            {/* Loading indicator */}
            {simCaseLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: 11 }}>
                <div style={{ width: 12, height: 12, border: '2px solid #f59e0b', borderTopColor: 'transparent',
                  borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                Loading result file…
              </div>
            )}

            {!casesLoaded && (
              <div style={{ fontSize: 11, color: '#ef4444' }}>
                cases_index.json not found in /simulation_results/
              </div>
            )}

            <Divider />
            <SharedControls uiState={uiState} setField={setField} cbMin={cbMin} cbMax={cbMax} simMode />
          </div>

        ) : (
          /* ── Live modal tab ────────────────────────────────────────────── */
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Connection card */}
            <div style={{ background: '#0e0e20', borderRadius: 8, border: '1px solid #1e2035', padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13 }}>📡</span>
                <span style={{ fontWeight: 700, color: '#cde', fontSize: 12 }}>Real-time FFT</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                  color: { idle:'#556', connecting:'#f59e0b', connected:'#10b981', error:'#ef4444' }[liveStatus] }}>
                  ● {liveStatus.toUpperCase()}
                </span>
              </div>
              <p style={{ margin: '0 0 10px', fontSize: 10, color: '#556', lineHeight: 1.5 }}>
                Suscribe a <code style={{ color: '#9ab' }}>oc4/pose</code>, calcula FFT y
                proyecta las amplitudes modales sobre la malla en tiempo real.
              </p>
              <button
                onClick={liveStatus === 'connected' ? disconnectLiveModal : connectLiveModal}
                disabled={liveStatus === 'connecting'}
                style={{
                  width: '100%', padding: '7px 10px', borderRadius: 6, border: 'none',
                  cursor: liveStatus === 'connecting' ? 'default' : 'pointer',
                  fontSize: 11, fontWeight: 700,
                  background: liveStatus === 'connected' ? '#2d1010' : '#0d2035',
                  color:      liveStatus === 'connected' ? '#ef4444' : '#7eb8f7',
                  opacity: liveStatus === 'connecting' ? 0.6 : 1,
                }}>
                {liveStatus === 'connected'  ? '⏹ Stop Live'   :
                 liveStatus === 'connecting' ? 'Connecting…'    : '▶ Start Live'}
              </button>
            </div>

            {/* Live telemetry */}
            {liveInfo && (
              <>
                <div style={{ background: '#0e0e20', borderRadius: 8, border: '1px solid #1e2035', padding: 10 }}>
                  <span style={{ ...labelStyle, display: 'block', marginBottom: 6 }}>Signal</span>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    {[
                      ['FPS',      `${liveInfo.fps.toFixed(1)} Hz`],
                      ['Nyquist',  `${liveInfo.nyquist_hz.toFixed(2)} Hz`],
                      ['Buffer',   `${liveInfo.n_samples} smp`],
                      ['Modes',    `${liveInfo.matched_modes.length} det`],
                    ].map(([k, v]) => (
                      <div key={k} style={{ background: '#181828', borderRadius: 4, padding: '4px 8px' }}>
                        <div style={{ color: '#556', fontSize: 10 }}>{k}</div>
                        <div style={{ color: '#7eb8f7', fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {liveInfo.matched_modes.length > 0 && (
                  <div style={{ background: '#0e0e20', borderRadius: 8, border: '1px solid #1e2035', padding: 10 }}>
                    <span style={{ ...labelStyle, display: 'block', marginBottom: 6 }}>Matched modes</span>
                    {liveInfo.matched_modes.slice(0, 8).map(m => (
                      <div key={m.mode_id} style={{ marginBottom: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                          <span style={{ color: '#cde', fontSize: 11 }}>Mode {m.mode_id}</span>
                          <span style={{ color: '#556', fontSize: 10, fontFamily: 'monospace' }}>
                            {m.freq_hz.toFixed(3)} Hz
                          </span>
                        </div>
                        <div style={{ height: 4, borderRadius: 2, background: '#1e2035' }}>
                          <div style={{
                            height: '100%', borderRadius: 2,
                            width: `${(m.normalized_amplitude * 100).toFixed(1)}%`,
                            background: `hsl(${200 + m.normalized_amplitude * 60},80%,60%)`,
                          }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {liveInfo.matched_modes.length === 0 && (
                  <div style={{ fontSize: 11, color: '#556', textAlign: 'center', padding: '8px 0' }}>
                    Sin modos detectados — acumulando muestras…
                  </div>
                )}
              </>
            )}

            <Divider />
            <SharedControls uiState={uiState} setField={setField} cbMin={cbMin} cbMax={cbMax} />
          </div>
        )}

        {/* ── Scene objects visibility (persistent, all tabs) ── */}
        {!loading && (
          <div style={{ borderTop: '1px solid #1e2035' }}>
            <button onClick={() => setObjPanelOpen(p => !p)} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer',
              color: '#9ab', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8,
            }}>
              <span style={{ marginRight: 'auto' }}>👁 Scene Objects</span>
              <span style={{ fontSize: 10, color: '#556' }}>{objPanelOpen ? '▲' : '▼'}</span>
            </button>
            {objPanelOpen && (
              <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={meshVisible}
                    onChange={e => setMeshVisible(e.target.checked)}
                    style={{ accentColor: '#f7c07e', width: 14, height: 14 }} />
                  <span style={{ color: '#cdd', fontSize: 12 }}>FEM Mesh</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: '#556' }}>malla</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={objVisible}
                    onChange={e => setObjVisible(e.target.checked)}
                    style={{ accentColor: '#7eb8f7', width: 14, height: 14 }} />
                  <span style={{ color: '#cdd', fontSize: 12 }}>Modelo 3D</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: '#556' }}>
                    {sceneObjectsRef.current.length} obj
                  </span>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: objVisible ? 1 : 0.4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={labelStyle}>Opacity</span>
                    <span style={{ color: '#7eb8f7', fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>
                      {Math.round(objOpacity * 100)}%
                    </span>
                  </div>
                  <input type="range" min={0} max={1} step={0.01} value={objOpacity}
                    disabled={!objVisible}
                    onChange={e => setObjOpacity(Number(e.target.value))}
                    style={{ accentColor: '#7eb8f7', width: '100%' }} />
                </label>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Three.js canvas ── */}
      <div ref={mountRef} style={{ flex: 1, position: 'relative' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', color: '#7eb8f7', gap: 12 }}>
            <div style={{ width: 36, height: 36, border: '3px solid #7eb8f7', borderTopColor: 'transparent',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ fontSize: 13 }}>{loadStatus}</span>
          </div>
        )}

        {/* Live indicators */}
        {(mqttConnected || (tab === 'sim' && simWsConnected) || liveStatus === 'connected') && (
          <div style={{ position: 'absolute', top: 12, right: 12,
            background: '#0e1e0e', border: '1px solid #10b98133', borderRadius: 20,
            padding: '4px 12px', fontSize: 11, color: '#10b981', fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981',
              display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite' }} />
            {liveStatus === 'connected'
              ? `📡 FFT Live${liveInfo ? `  ${liveInfo.fps.toFixed(0)} Hz` : ''}`
              : mqttConnected ? `📡 ${mqttTopic}` : '🏗️ Node editor'}
          </div>
        )}

        {/* Live Nyquist + modes badge */}
        {tab === 'live' && liveStatus === 'connected' && liveInfo && (
          <div style={{ position: 'absolute', bottom: 12, right: 12,
            background: '#0a0a20', border: '1px solid #1e2035', borderRadius: 8,
            padding: '6px 12px', fontSize: 11, color: '#9ab', lineHeight: 1.6 }}>
            <div>Nyquist: <span style={{ color: '#7eb8f7', fontFamily: 'monospace' }}>{liveInfo.nyquist_hz.toFixed(2)} Hz</span></div>
            <div>Modos activos: <span style={{ color: '#7eb8f7', fontFamily: 'monospace' }}>{liveInfo.matched_modes.length}</span></div>
          </div>
        )}

        {/* Sim mode indicator */}
        {tab === 'sim' && !loading && (
          <div style={{ position: 'absolute', bottom: 12, right: 12,
            background: '#0a0a20', border: '1px solid #1e2035', borderRadius: 8,
            padding: '6px 12px', fontSize: 11, color: '#9ab' }}>
            {simParams.mode === 'wind'
              ? `💨 U = ${simParams.windSpeed.toFixed(1)} m/s`
              : `🌊 Hs = ${simParams.waveHs.toFixed(2)} m  Tp = ${simParams.waveTp.toFixed(1)} s`}
          </div>
        )}

        <style>{`
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
        `}</style>
      </div>
    </div>
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────────
function SharedControls({
  uiState, setField, cbMin, cbMax, simMode,
}: {
  uiState: State;
  setField: <K extends keyof State>(k: K, v: State[K]) => void;
  cbMin: string; cbMax: string;
  simMode?: boolean;
}) {
  return (
    <>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>
          Deformation scale {simMode ? <span style={{ color: '#445' }}>(×0.001)</span> : ''}
        </span>
        <input type="number" min={0} step={10} value={uiState.defScale}
          onChange={e => setField('defScale', Math.max(0, Number(e.target.value)))}
          style={{ ...selectStyle, fontSize: 13 }} />
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={uiState.showDeform}
          onChange={e => setField('showDeform', e.target.checked)}
          style={{ accentColor: '#7eb8f7', width: 14, height: 14 }} />
        <span style={{ color: '#cdd' }}>Show deformation</span>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>Color by</span>
        <select value={uiState.colorBy} onChange={e => setField('colorBy', e.target.value as ColorComponent)} style={selectStyle}>
          <option value="magnitude">Magnitude |u|</option>
          <option value="x">Component X</option>
          <option value="y">Component Y</option>
          <option value="z">Component Z</option>
        </select>
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>Colorbar</span>
        <div style={{ fontSize: 10, color: '#9ab', textAlign: 'right' }}>{cbMax}</div>
        <div style={{ height: 140, borderRadius: 4,
          background: 'linear-gradient(to bottom, #7a0403,#fb8022,#c2df25,#31d056,#1f9ebe,#4454c4,#30123b)' }} />
        <div style={{ fontSize: 10, color: '#9ab' }}>{cbMin}</div>
      </div>
    </>
  );
}

function StatsPanel({ stats }: { stats: { vertices: number; triangles: number; numModes: number; mapped: number } }) {
  return (
    <div>
      <span style={{ ...labelStyle, display: 'block', marginBottom: 6 }}>Stats</span>
      {[
        ['Vertices', stats.vertices.toLocaleString()],
        ['Triangles', stats.triangles.toLocaleString()],
        ['Modes', stats.numModes],
        ['Mapped nodes', stats.mapped.toLocaleString()],
      ].map(([k, v]) => (
        <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ color: '#556' }}>{k}</span>
          <span style={{ color: '#cde' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Divider() { return <div style={{ borderTop: '1px solid #1e2035' }} />; }

const labelStyle: React.CSSProperties = { color: '#9ab', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8 };
const selectStyle: React.CSSProperties = {
  background: '#181828', border: '1px solid #2a2d4a', color: '#e0e6f0',
  borderRadius: 6, padding: '5px 8px', fontSize: 12, width: '100%', outline: 'none',
};

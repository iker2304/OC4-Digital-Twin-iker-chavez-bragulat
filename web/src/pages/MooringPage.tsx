import { useEffect, useMemo, useState } from 'react';
import {
  Anchor,
  Activity,
  Cpu,
  Sliders,
  Play,
  Radio,
  AlertTriangle,
  CheckCircle2,
  BookOpen,
  Waves,
  RefreshCw,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line as RechartLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import Mooring3DViewer from '../components/mooring/Mooring3DViewer';
import MooringArchitectureDiagram from '../components/mooring/MooringArchitectureDiagram';
import { API_BASE_URL, WS_BASE_URL } from '../config/api';
import {
  OC4_MOORING_PARAMS,
  SHM_CLASSES,
  simulateMooringClientSide,
  type MooringAnalysisOutput,
  type MooringEnvInput,
  type MooringPoseInput,
  type ShmClass,
} from '../physics/MooringEngine';

type TabKey = 'twin3d' | 'architecture' | 'physics';
type DataSourceMode = 'interactive' | 'live_ws' | 'recording';

interface BackendArchInfo {
  torch_engine_available: boolean;
  checkpoint_loaded: boolean;
  parameters_count: number;
}

const DEFAULT_POSE: MooringPoseInput = {
  surge: 0,
  sway: 0,
  heave: 0,
  rollDeg: 0,
  pitchDeg: 0,
  yawDeg: 0,
};

const DEFAULT_ENV: MooringEnvInput = {
  waveHeight: 1.5,
  wavePeriod: 10.0,
  windSpeed: 8.0,
  currentSpeed: 0.5,
};

const LOSS_TERMS = [
  {
    name: 'L_data (Posición & Tensión)',
    weight: 'λ_pos = 10.0 · λ_ten = 5.0',
    formula: 'MSE(r_pred, r_ref) + MSE(T_pred, T_ref) + BCE(p_td, td_ref)',
    purpose: 'Ancla las predicciones a datos de simulación o sensores observados cuando están disponibles.',
  },
  {
    name: 'L_const (Ley Constitutiva Axial)',
    weight: 'λ_const = 2.0',
    formula: 'MSE(T_ij, ReLU(EA_eff · ReLU((||Δr_ij|| - l0)/l0) + c_int · ε̇_ij))',
    purpose: 'Garantiza la ley de Hooke solo a tracción (sin resistencia a compresión) en cada segmento.',
  },
  {
    name: 'L_momentum (EDP Balance 3D)',
    weight: 'λ_pde = 1.0',
    formula: 'M_a · a_i = (T_i τ_i - T_{i-1} τ_{i-1}) + f_grav + f_Morison + f_seabed',
    purpose: 'Impone conservación del momento lineal 3D con arrastre Morison, masa añadida y apoyo en lecho.',
  },
  {
    name: 'L_bc (Contorno Dirichlet)',
    weight: 'λ_bc = 10.0',
    formula: '||r_0 - r_anch||² + ||r_N - r_fair(q_p)||² + ||v_N - v_fair||²',
    purpose: 'Acopla exactamente el ancla fija y el fairlead movido por la pose 6-DOF de la cámara.',
  },
  {
    name: 'L_seabed (No Penetración)',
    weight: 'λ_bed = 5.0',
    formula: 'mean( ReLU(-200.0 - z_i)² )',
    purpose: 'Prohíbe que cualquier nodo atraviese el fondo marino en z = -200 m.',
  },
  {
    name: 'L_shm (Diagnóstico Inverso)',
    weight: 'λ_cls = 1.5 · λ_hlth = 2.0',
    formula: 'CrossEntropy(shm_logits, cls) + MSE([δ_EA, δ_w], [EA/EA0, w/w0])',
    purpose: 'Clasifica anomalías por línea e identifica degradación de rigidez o biofouling.',
  },
];

export default function MooringPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('twin3d');
  const [sourceMode, setSourceMode] = useState<DataSourceMode>('interactive');
  const [colorMode, setColorMode] = useState<'tension' | 'touchdown'>('tension');
  const [pose, setPose] = useState<MooringPoseInput>(DEFAULT_POSE);
  const [env, setEnv] = useState<MooringEnvInput>(DEFAULT_ENV);
  const [faultLineIdx, setFaultLineIdx] = useState<number>(0);
  const [faultClass, setFaultClass] = useState<ShmClass>('HEALTHY');

  const [archInfo, setArchInfo] = useState<BackendArchInfo>({
    torch_engine_available: false,
    checkpoint_loaded: false,
    parameters_count: 1312018,
  });
  const [backendOnline, setBackendOnline] = useState(false);
  const [recordings, setRecordings] = useState<{ id: string }[]>([]);
  const [selectedRec, setSelectedRec] = useState<string>('');
  const [recFrames, setRecFrames] = useState<any[]>([]);
  const [recFrameIdx, setRecFrameIdx] = useState<number>(0);
  const [isPlayingRec, setIsPlayingRec] = useState<boolean>(false);
  const [liveAnalysis, setLiveAnalysis] = useState<MooringAnalysisOutput | null>(null);

  const apiBase = API_BASE_URL;

  // Fetch architecture metadata & recordings list from backend if available
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBase}/api/mooring/architecture`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setBackendOnline(true);
          setArchInfo({
            torch_engine_available: Boolean(data.torch_engine_available),
            checkpoint_loaded: Boolean(data.checkpoint_loaded),
            parameters_count: Number(data.parameters_count || 1312018),
          });
        }
      })
      .catch(() => setBackendOnline(false));

    fetch(`${apiBase}/api/mooring/recordings`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.recordings) {
          setRecordings(data.recordings);
          if (data.recordings.length > 0) setSelectedRec(data.recordings[0].id);
        }
      })
      .catch(() => {});

    return () => controller.abort();
  }, [apiBase]);

  // Live WebSocket stream when sourceMode === 'live_ws'
  useEffect(() => {
    if (sourceMode !== 'live_ws') return;
    const ws = new WebSocket(`${WS_BASE_URL}/api/mooring/ws/live`);
    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(ev.data);
        if (!raw?.mooring) return;
        const p = raw.platform_pose_prototype || {};
        setPose({
          surge: p.surge_m ?? 0,
          sway: p.sway_m ?? 0,
          heave: p.heave_m ?? 0,
          rollDeg: p.roll_deg ?? 0,
          pitchDeg: p.pitch_deg ?? 0,
          yawDeg: p.yaw_deg ?? 0,
        });
        setLiveAnalysis(convertBackendPayload(raw));
      } catch {
        // ignore parse glitch
      }
    };
    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [sourceMode]);

  // Recording playback timer
  useEffect(() => {
    if (sourceMode !== 'recording' || !isPlayingRec || recFrames.length === 0) return;
    const timer = setInterval(() => {
      setRecFrameIdx((prev) => (prev + 1) % recFrames.length);
    }, 200);
    return () => clearInterval(timer);
  }, [sourceMode, isPlayingRec, recFrames]);

  useEffect(() => {
    if (sourceMode === 'recording' && recFrames[recFrameIdx]) {
      const fr = recFrames[recFrameIdx];
      const p = fr.platform_pose_prototype || {};
      setPose({
        surge: p.surge_m ?? 0,
        sway: p.sway_m ?? 0,
        heave: p.heave_m ?? 0,
        rollDeg: p.roll_deg ?? 0,
        pitchDeg: p.pitch_deg ?? 0,
        yawDeg: p.yaw_deg ?? 0,
      });
      setLiveAnalysis(convertBackendPayload(fr));
    }
  }, [sourceMode, recFrames, recFrameIdx]);

  const loadRecording = async (recId: string) => {
    if (!recId) return;
    try {
      const resp = await fetch(`${apiBase}/api/mooring/recordings/${recId}?max_frames=30`);
      if (!resp.ok) return;
      const data = await resp.json();
      setRecFrames(data.frames || []);
      setRecFrameIdx(0);
      setIsPlayingRec(true);
    } catch {
      // ignore if offline
    }
  };

  // Client-side instantaneous elastic catenary calculation for interactive mode
  const interactiveAnalysis = useMemo(
    () =>
      simulateMooringClientSide(
        pose,
        env,
        faultClass === 'HEALTHY' ? null : { lineIdx: faultLineIdx, shmClass: faultClass }
      ),
    [pose, env, faultLineIdx, faultClass]
  );

  const activeAnalysis =
    sourceMode !== 'interactive' && liveAnalysis ? liveAnalysis : interactiveAnalysis;

  // Profile chart data along s in [0, 835.5m]
  const profileChartData = useMemo(() => {
    const nSeg = OC4_MOORING_PARAMS.segmentsPerLine;
    const segLen = OC4_MOORING_PARAMS.unstretchedLengthM / nSeg;
    return Array.from({ length: nSeg }, (_, i) => ({
      s_m: Math.round((i + 0.5) * segLen),
      L1: activeAnalysis.lines[0]?.segmentTensionsKN[i] ?? 0,
      L2: activeAnalysis.lines[1]?.segmentTensionsKN[i] ?? 0,
      L3: activeAnalysis.lines[2]?.segmentTensionsKN[i] ?? 0,
    }));
  }, [activeAnalysis]);

  const applyPreset = (name: 'eq' | 'surge' | 'sway' | 'storm') => {
    setSourceMode('interactive');
    if (name === 'eq') {
      setPose(DEFAULT_POSE);
      setEnv(DEFAULT_ENV);
      setFaultClass('HEALTHY');
    } else if (name === 'surge') {
      setPose({ surge: 10.5, sway: 0, heave: -0.4, rollDeg: 0, pitchDeg: 4.5, yawDeg: 0 });
      setEnv({ waveHeight: 3.5, wavePeriod: 11, windSpeed: 14, currentSpeed: 0.9 });
    } else if (name === 'sway') {
      setPose({ surge: 1.5, sway: 9.0, heave: 0.2, rollDeg: 5.0, pitchDeg: 1.0, yawDeg: 4.0 });
      setEnv({ waveHeight: 2.5, wavePeriod: 9.5, windSpeed: 10, currentSpeed: 1.2 });
    } else if (name === 'storm') {
      setPose({ surge: 12.0, sway: -5.0, heave: -1.8, rollDeg: -5.5, pitchDeg: 6.5, yawDeg: -6.0 });
      setEnv({ waveHeight: 6.0, wavePeriod: 14.0, windSpeed: 24.0, currentSpeed: 1.6 });
    }
  };

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto">
      {/* Header + Tabs */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 border-b border-gray-200 dark:border-slate-700 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2.5">
            <Anchor className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            Gemelo Digital de Líneas de Fondeo (GNN + PINN)
          </h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            OC4-DeepCwind Semi-submersible · Predicción de tensiones 3D, Touchdown Zone y diagnóstico SHM
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 border ${
              backendOnline
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20'
                : 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${backendOnline ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            {backendOnline
              ? archInfo.torch_engine_available
                ? 'Backend PyTorch Activo'
                : 'Backend NumPy Catenaria Activo'
              : 'Modo Local Navegador (Catenaria Elástica)'}
          </span>

          <div className="flex bg-gray-100 dark:bg-slate-800 p-1 rounded-xl border border-gray-200 dark:border-slate-700">
            <button
              onClick={() => setActiveTab('twin3d')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'twin3d'
                  ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-white shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:text-gray-900'
              }`}
            >
              <Waves className="w-3.5 h-3.5" /> Visor 3D & Estado
            </button>
            <button
              onClick={() => setActiveTab('architecture')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'architecture'
                  ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:text-gray-900'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" /> Arquitectura GNN + PINN
            </button>
            <button
              onClick={() => setActiveTab('physics')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'physics'
                  ? 'bg-white dark:bg-slate-700 text-emerald-600 dark:text-white shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:text-gray-900'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" /> Física, Pérdidas y Outputs
            </button>
          </div>
        </div>
      </div>

      {/* TAB 1: 3D Viewer & Line Telemetry */}
      {activeTab === 'twin3d' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* 3D Canvas + Color mode */}
            <div className="xl:col-span-2 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setColorMode('tension')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                      colorMode === 'tension'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 border-gray-200 dark:border-slate-700'
                    }`}
                  >
                    Colorear por Tensión Axial
                  </button>
                  <button
                    onClick={() => setColorMode('touchdown')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                      colorMode === 'touchdown'
                        ? 'bg-amber-600 text-white border-amber-600'
                        : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 border-gray-200 dark:border-slate-700'
                    }`}
                  >
                    Colorear por Contacto Fondo (TDZ)
                  </button>
                </div>

                <div className="text-xs font-mono text-gray-500 dark:text-slate-400">
                  F_horiz: <strong className="text-gray-900 dark:text-white">{activeAnalysis.totalHorizontalForceKN.toFixed(1)} kN</strong> ·{' '}
                  F_vert: <strong className="text-gray-900 dark:text-white">{activeAnalysis.totalVerticalForceKN.toFixed(1)} kN</strong> ·{' '}
                  {activeAnalysis.inferenceMs.toFixed(2)} ms
                </div>
              </div>

              <Mooring3DViewer analysis={activeAnalysis} pose={pose} colorMode={colorMode} />

              {/* Tension Profile Chart along arc length s */}
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
                    <Activity className="w-4 h-4 text-blue-500" />
                    Perfil de Tensión Axial T(s) a lo largo de la Línea (0m Ancla → 835.5m Fairlead)
                  </h3>
                  <span className="text-xs font-mono text-gray-400">MBL = 10,000 kN</span>
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={profileChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.25} />
                      <XAxis dataKey="s_m" tick={{ fontSize: 11 }} unit="m" />
                      <YAxis tick={{ fontSize: 11 }} unit=" kN" />
                      <Tooltip />
                      <Legend />
                      <RechartLine type="monotone" dataKey="L1" name="Línea 1 (180°)" stroke="#3b82f6" strokeWidth={2} dot={false} />
                      <RechartLine type="monotone" dataKey="L2" name="Línea 2 (60°)" stroke="#10b981" strokeWidth={2} dot={false} />
                      <RechartLine type="monotone" dataKey="L3" name="Línea 3 (300°)" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Right Controls + Per-Line Cards */}
            <div className="space-y-4">
              {/* Source mode switcher */}
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5" /> Fuente de Pose 6-DOF
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    onClick={() => setSourceMode('interactive')}
                    className={`py-1.5 px-2 rounded-lg text-xs font-semibold border ${
                      sourceMode === 'interactive'
                        ? 'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700'
                        : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400'
                    }`}
                  >
                    Interactivo
                  </button>
                  <button
                    onClick={() => setSourceMode('live_ws')}
                    disabled={!backendOnline}
                    className={`py-1.5 px-2 rounded-lg text-xs font-semibold border flex items-center justify-center gap-1 ${
                      sourceMode === 'live_ws'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 disabled:opacity-40'
                    }`}
                  >
                    <Radio className="w-3 h-3" /> Live MQTT
                  </button>
                  <button
                    onClick={() => setSourceMode('recording')}
                    disabled={!backendOnline || recordings.length === 0}
                    className={`py-1.5 px-2 rounded-lg text-xs font-semibold border flex items-center justify-center gap-1 ${
                      sourceMode === 'recording'
                        ? 'bg-indigo-50 text-indigo-700 border-indigo-300 dark:bg-indigo-900/30 dark:text-indigo-300'
                        : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 disabled:opacity-40'
                    }`}
                  >
                    <Play className="w-3 h-3" /> Grabación
                  </button>
                </div>

                {sourceMode === 'recording' && (
                  <div className="flex items-center gap-2 pt-1">
                    <select
                      value={selectedRec}
                      onChange={(e) => setSelectedRec(e.target.value)}
                      className="flex-1 text-xs rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1.5"
                    >
                      {recordings.map((r) => (
                        <option key={r.id} value={r.id}>{r.id}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => loadRecording(selectedRec)}
                      className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-500"
                    >
                      Cargar
                    </button>
                  </div>
                )}

                {sourceMode === 'interactive' && (
                  <>
                    {/* Quick Scenarios */}
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <button onClick={() => applyPreset('eq')} className="px-2.5 py-1 text-[11px] rounded-md bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 font-medium">
                        Equilibrio
                      </button>
                      <button onClick={() => applyPreset('surge')} className="px-2.5 py-1 text-[11px] rounded-md bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium">
                        Surge +10.5m
                      </button>
                      <button onClick={() => applyPreset('sway')} className="px-2.5 py-1 text-[11px] rounded-md bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 font-medium">
                        Deriva Sway
                      </button>
                      <button onClick={() => applyPreset('storm')} className="px-2.5 py-1 text-[11px] rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-medium">
                        Tormenta
                      </button>
                    </div>

                    {/* 6-DOF Sliders */}
                    <div className="space-y-2 pt-2">
                      {(
                        [
                          ['surge', 'Surge (X)', -15, 15, 0.5, 'm'],
                          ['sway', 'Sway (Y)', -15, 15, 0.5, 'm'],
                          ['heave', 'Heave (Z)', -3, 3, 0.1, 'm'],
                          ['rollDeg', 'Roll (φ)', -10, 10, 0.5, '°'],
                          ['pitchDeg', 'Pitch (θ)', -10, 10, 0.5, '°'],
                          ['yawDeg', 'Yaw (ψ)', -12, 12, 0.5, '°'],
                        ] as const
                      ).map(([key, label, min, max, step, unit]) => (
                        <div key={key} className="space-y-0.5">
                          <div className="flex justify-between text-xs">
                            <span className="text-gray-600 dark:text-slate-300">{label}</span>
                            <span className="font-mono font-semibold text-gray-900 dark:text-white">
                              {pose[key].toFixed(1)} {unit}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            step={step}
                            value={pose[key]}
                            onChange={(e) => setPose((p) => ({ ...p, [key]: parseFloat(e.target.value) }))}
                            className="w-full accent-blue-600 h-1.5"
                          />
                        </div>
                      ))}
                    </div>

                    {/* Fault Injection for SHM testing */}
                    <div className="pt-2 border-t border-gray-100 dark:border-slate-700 space-y-2">
                      <div className="flex items-center justify-between text-xs font-semibold text-gray-600 dark:text-slate-300">
                        <span>Simulación de Anomalía SHM</span>
                        <button
                          onClick={() => setFaultClass('HEALTHY')}
                          className="text-[11px] text-blue-500 hover:underline flex items-center gap-1"
                        >
                          <RefreshCw className="w-3 h-3" /> Reset
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={faultLineIdx}
                          onChange={(e) => setFaultLineIdx(Number(e.target.value))}
                          className="text-xs rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1.5"
                        >
                          <option value={0}>Línea 1 (180°)</option>
                          <option value={1}>Línea 2 (60°)</option>
                          <option value={2}>Línea 3 (300°)</option>
                        </select>
                        <select
                          value={faultClass}
                          onChange={(e) => setFaultClass(e.target.value as ShmClass)}
                          className="text-xs rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1.5"
                        >
                          {SHM_CLASSES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Per-line telemetry cards */}
              <div className="space-y-2.5">
                {activeAnalysis.lines.map((ln) => {
                  const sfColor =
                    ln.safetyFactor >= 2.0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : ln.safetyFactor >= 1.67
                        ? 'text-amber-500'
                        : 'text-red-500';
                  const isHealthy = ln.shmStatus === 'HEALTHY';
                  return (
                    <div
                      key={ln.id}
                      className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-3.5 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-gray-900 dark:text-white">
                            Línea #{ln.id} ({ln.azimuthDeg}°)
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 ${
                              isHealthy
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                                : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400'
                            }`}
                          >
                            {isHealthy ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                            {ln.shmStatus}
                          </span>
                        </div>
                        <span className={`text-xs font-mono font-bold ${sfColor}`}>
                          SF {ln.safetyFactor.toFixed(2)}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <div className="text-[10px] text-gray-400">Fairlead</div>
                          <div className="font-mono font-bold text-gray-800 dark:text-slate-100">
                            {ln.tensionFairleadKN.toFixed(1)} kN
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-400">Ancla</div>
                          <div className="font-mono font-bold text-gray-800 dark:text-slate-100">
                            {ln.tensionAnchorKN.toFixed(1)} kN
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-400">Apoyo Fondo</div>
                          <div className="font-mono font-bold text-gray-800 dark:text-slate-100">
                            {ln.laidLengthM.toFixed(0)} m
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Interactive GNN + PINN Architecture Explorer */}
      {activeTab === 'architecture' && (
        <MooringArchitectureDiagram
          paramCount={archInfo.parameters_count}
          checkpointLoaded={archInfo.checkpoint_loaded}
        />
      )}

      {/* TAB 3: Physics Equations, Losses & Comparison */}
      {activeTab === 'physics' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {LOSS_TERMS.map((item) => (
              <div
                key={item.name}
                className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-5 space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-bold text-sm text-gray-900 dark:text-white">{item.name}</h4>
                </div>
                <span className="inline-block px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 text-[11px] font-mono">
                  {item.weight}
                </span>
                <div className="bg-slate-900 text-amber-200 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto">
                  {item.formula}
                </div>
                <p className="text-xs text-gray-600 dark:text-slate-400 leading-relaxed">{item.purpose}</p>
              </div>
            ))}
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6">
            <h3 className="text-base font-bold text-gray-900 dark:text-white mb-4">
              Comparativa entre las dos ramas del sistema: MooringPIGNN vs. ContinuousMooringPINN
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400">
                    <th className="py-2.5 pr-4">Característica</th>
                    <th className="py-2.5 pr-4">MooringPIGNN (GNN + PINN Discreta)</th>
                    <th className="py-2.5">ContinuousMooringPINN (PINN Continua)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-700/60 text-gray-700 dark:text-slate-300">
                  <tr>
                    <td className="py-2.5 pr-4 font-semibold">Representación</td>
                    <td className="py-2.5 pr-4">Grafo fijo de 64 nodos y 126 aristas (3 líneas + plataforma)</td>
                    <td className="py-2.5">Coordenadas continuas (s/L0, t) con Fourier Features</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4 font-semibold">Derivadas físicas</td>
                    <td className="py-2.5 pr-4">Diferencias finitas espaciales en segmentos + balance nodal</td>
                    <td className="py-2.5">Exactas mediante torch.autograd.grad (1.º y 2.º orden)</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4 font-semibold">Contorno Dirichlet</td>
                    <td className="py-2.5 pr-4">Máscara exacta en ancla y fairlead + término L_bc</td>
                    <td className="py-2.5">Ansatz analítico exacto s(1-s) (error 0 por construcción)</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4 font-semibold">Uso principal en el Gemelo</td>
                    <td className="py-2.5 pr-4">Inferencia en tiempo real (~5 ms) y diagnóstico SHM multi-línea</td>
                    <td className="py-2.5">Evaluación de alta resolución en cualquier punto s ∈ [0, L0]</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function convertBackendPayload(raw: any): MooringAnalysisOutput {
  const m = raw.mooring || {};
  const nodes3dAll: [number, number, number][][] = m.nodes_3d_m || [];
  const segTensionsAll: number[][] = m.segment_tensions_kN || [];
  const tdAll: number[][] = m.touchdown_probabilities || [];

  const lines = (m.lines || []).map((ln: any, k: number) => ({
    id: ln.id ?? k + 1,
    azimuthDeg: ln.azimuth_deg ?? OC4_MOORING_PARAMS.lineAnglesDeg[k],
    tensionFairleadKN: ln.tension_fairlead_kN ?? 0,
    tensionAnchorKN: ln.tension_anchor_kN ?? 0,
    safetyFactor: ln.safety_factor ?? 9.9,
    laidLengthM: ln.laid_length_m ?? 0,
    touchdownNodeIdx: ln.touchdown_node_idx ?? 0,
    shmStatus: (ln.shm_status as ShmClass) || 'HEALTHY',
    shmProbabilities: ln.shm_probabilities || {
      HEALTHY: 1,
      PRETENSION_LOSS: 0,
      STIFFNESS_DEGRADATION: 0,
      BIOFOULING: 0,
      LINE_BREAKAGE: 0,
    },
    eaHealthRatio: ln.ea_health_ratio ?? 1.0,
    weightRatio: ln.weight_ratio ?? 1.0,
    nodes3d: nodes3dAll[k] || [],
    segmentTensionsKN: segTensionsAll[k] || [],
    touchdownProbs: tdAll[k] || [],
  }));

  return {
    mode: raw.mode || 'backend',
    inferenceMs: raw.inference_ms || 0,
    lines,
    totalHorizontalForceKN: m.total_horizontal_force_kN ?? 0,
    totalVerticalForceKN: m.total_vertical_force_kN ?? 0,
    fairleadPositions: lines.map((l: any) => l.nodes3d[l.nodes3d.length - 1] || [0, 0, 0]),
    anchorPositions: lines.map((l: any) => l.nodes3d[0] || [0, 0, -200]),
  };
}

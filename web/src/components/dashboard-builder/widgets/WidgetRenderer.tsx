import { useMemo, Suspense, useState, useEffect, useCallback } from 'react';
import { Layers, Eye, EyeOff, ArrowUpRight, ArrowDownRight, MapPin, Box } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { useGLTF, OrbitControls, Stage } from '@react-three/drei';
import {
  LineChart, Line, BarChart, Bar, ResponsiveContainer, XAxis, YAxis,
  Tooltip, CartesianGrid,
} from 'recharts';
import type { DashboardWidget, StreamDefinition } from '../../../store/dashboardStore';
import { API_BASE_URL } from '../../../config/api';
import { Glyph } from '../../ui/Glyph';

interface WidgetRendererProps {
  widget: DashboardWidget;
  stream?: StreamDefinition;
  editMode?: boolean;
}

function genDemoTimeSeries(n = 30, base = 50, amp = 15) {
  return Array.from({ length: n }, (_, i) => ({
    t: i,
    v: +(base + amp * Math.sin(i * 0.4) + (Math.random() - 0.5) * 5).toFixed(2),
  }));
}

// ── Time Series ──
function TimeSeriesWidget({ widget, stream }: { widget: DashboardWidget; stream?: StreamDefinition }) {
  const color = (widget.config.color as string) || '#2563eb';
  const [data, setData] = useState(() => genDemoTimeSeries());

  useEffect(() => {
    if (!stream) return;

    const interval = setInterval(() => {
      if (stream.lastValue !== undefined && stream.lastValue !== null) {
        let nextVal = 0;
        if (Array.isArray(stream.lastValue)) {
          nextVal = stream.lastValue.length;
        } else {
          const val = typeof stream.lastValue === 'number' ? stream.lastValue : parseFloat(String(stream.lastValue));
          if (!isNaN(val)) nextVal = val;
        }
        setData(prev => [...prev.slice(-29), { t: Date.now(), v: nextVal }]);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [stream]);

  useEffect(() => {
    if (!widget.streamId || stream) return;

    const pollManualStream = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/persist/stream-values/${widget.streamId}`);
        if (res.ok) {
          const val = await res.json();
          if (val.lastValue !== undefined && val.lastValue !== null) {
            let nextVal = 0;
            if (Array.isArray(val.lastValue)) {
              nextVal = val.lastValue.length;
            } else {
              const numVal = typeof val.lastValue === 'number' ? val.lastValue : parseFloat(String(val.lastValue));
              if (!isNaN(numVal)) nextVal = numVal;
            }
            setData(prev => [...prev.slice(-29), { t: Date.now(), v: nextVal }]);
          }
        }
      } catch (e) {
        console.error('[WidgetRenderer] Manual stream poll error:', e);
      }
    };

    pollManualStream();
    const interval = setInterval(pollManualStream, 2000);
    return () => clearInterval(interval);
  }, [widget.streamId, stream]);

  return (
    <div className="flex h-full flex-col">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis dataKey="t" tick={{ fontSize: 9, fill: 'var(--chart-axis)' }} hide={!stream} />
          <YAxis tick={{ fontSize: 9, fill: 'var(--chart-axis)' }} />
          <Tooltip
            contentStyle={{
              background: 'var(--chart-tooltip-bg)',
              border: '1px solid var(--chart-tooltip-border)',
              borderRadius: '8px',
              fontSize: '11px',
              color: 'var(--chart-tooltip-fg)',
            }}
          />
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.75} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Gauge ──
function GaugeWidget({ widget, stream }: { widget: DashboardWidget; stream?: StreamDefinition }) {
  const min = (widget.config.min as number) || 0;
  const max = (widget.config.max as number) || 100;
  const unit = (widget.config.unit as string) || '%';
  const [manualVal, setManualVal] = useState<number | null>(null);

  const val = manualVal ?? (stream?.lastValue as number) ?? 68;
  const pct = Math.max(0, Math.min(1, (val - min) / (max - min)));
  const angle = -135 + pct * 270;
  const color = pct < 0.7 ? '#10b981' : pct < 0.9 ? '#f59e0b' : '#ef4444';

  useEffect(() => {
    if (!widget.streamId || stream) return;

    const pollManualStream = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/persist/stream-values/${widget.streamId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.lastValue !== undefined && data.lastValue !== null) {
            const numVal = typeof data.lastValue === 'number' ? data.lastValue : parseFloat(String(data.lastValue));
            if (!isNaN(numVal)) setManualVal(numVal);
          }
        }
      } catch (e) {
        console.log('[WidgetRenderer] Gauge manual stream poll error:', e);
      }
    };

    pollManualStream();
    const interval = setInterval(pollManualStream, 2000);
    return () => clearInterval(interval);
  }, [widget.streamId, stream]);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <svg width="120" height="80" viewBox="0 0 120 80">
          <path d="M 15 75 A 50 50 0 0 1 105 75" fill="none" stroke="var(--chart-grid)" strokeWidth="8" strokeLinecap="round" />
          <path
            d="M 15 75 A 50 50 0 0 1 105 75"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${pct * 157} 157`}
          />
          <line
            x1="60"
            y1="75"
            x2={60 + 35 * Math.cos((angle - 90) * (Math.PI / 180))}
            y2={75 + 35 * Math.sin((angle - 90) * (Math.PI / 180))}
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <circle cx="60" cy="75" r="4" fill={color} />
        </svg>
        <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
          {val.toFixed(1)}
          <span className="ml-0.5 text-xs text-zinc-500">{unit}</span>
        </p>
        <p className="text-[10px] text-zinc-400">
          {min} – {max}
        </p>
      </div>
    </div>
  );
}

// ── KPI Card ──
function KpiWidget({ widget, stream }: { widget: DashboardWidget; stream?: StreamDefinition }) {
  const unit = (widget.config.unit as string) || '';
  const precision = (widget.config.precision as number) ?? 2;
  const [manualVal, setManualVal] = useState<number | null>(null);

  const val = manualVal ?? (stream?.lastValue as number) ?? 42.73;
  const trend = (stream?.lastValue as number) ? 0 : 2.4;

  useEffect(() => {
    if (!widget.streamId || stream) return;

    const pollManualStream = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/persist/stream-values/${widget.streamId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.lastValue !== undefined && data.lastValue !== null) {
            const numVal = typeof data.lastValue === 'number' ? data.lastValue : parseFloat(String(data.lastValue));
            if (!isNaN(numVal)) setManualVal(numVal);
          }
        }
      } catch (e) {
        console.log('[WidgetRenderer] KPI manual stream poll error:', e);
      }
    };

    pollManualStream();
    const interval = setInterval(pollManualStream, 2000);
    return () => clearInterval(interval);
  }, [widget.streamId, stream]);

  return (
    <div className="flex h-full flex-col justify-center px-2">
      <p className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
        {typeof val === 'number' ? val.toFixed(precision) : String(val)}
        <span className="ml-1 text-sm font-normal text-zinc-400">{unit}</span>
      </p>
      {Boolean(widget.config.trend) && !stream && (
        <div className={`mt-1 flex items-center gap-1 text-xs font-medium ${trend >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
          {trend >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
          <span>{Math.abs(trend).toFixed(1)}% vs última hora</span>
        </div>
      )}
      {stream ? (
        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Stream: {stream.label}
        </p>
      ) : widget.streamId ? (
        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-blue-600 dark:text-blue-400">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
          Stream: {widget.streamId.slice(0, 8)}…
        </p>
      ) : (
        <p className="mt-1 text-[10px] text-zinc-400">Sin stream conectado</p>
      )}
    </div>
  );
}

// ── Bar Chart ──
function BarChartWidget({ widget }: { widget: DashboardWidget }) {
  const color = (widget.config.color as string) || '#2563eb';
  const data = useMemo(
    () => [
      { label: 'Mooring 1', v: 85 },
      { label: 'Mooring 2', v: 72 },
      { label: 'Tower Base', v: 91 },
      { label: 'Platform', v: 63 },
      { label: 'Nacelle', v: 78 },
    ],
    []
  );
  return (
    <div className="h-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={{ fontSize: 8, fill: 'var(--chart-axis)' }} angle={-30} textAnchor="end" />
          <YAxis tick={{ fontSize: 9, fill: 'var(--chart-axis)' }} />
          <Tooltip
            contentStyle={{
              background: 'var(--chart-tooltip-bg)',
              border: '1px solid var(--chart-tooltip-border)',
              borderRadius: '8px',
              fontSize: '11px',
            }}
          />
          <Bar dataKey="v" fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Sensor Table ──
function SensorTableWidget() {
  const rows = [
    { sensor: 'IMU Roll', value: '2.4°', status: 'nominal' },
    { sensor: 'IMU Pitch', value: '1.8°', status: 'nominal' },
    { sensor: 'Mooring T1', value: '1234 kN', status: 'warning' },
    { sensor: 'Tower Stress', value: '45 MPa', status: 'nominal' },
    { sensor: 'Wind Speed', value: '12.3 m/s', status: 'nominal' },
    { sensor: 'Wave Height', value: '2.5 m', status: 'nominal' },
  ];
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white dark:bg-zinc-900">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th className="px-2 py-1.5 text-left font-medium text-zinc-500">Sensor</th>
            <th className="px-2 py-1.5 text-right font-medium text-zinc-500">Valor</th>
            <th className="px-2 py-1.5 text-right font-medium text-zinc-500">Estado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-zinc-100 dark:border-zinc-800/60">
              <td className="px-2 py-1.5 text-zinc-700 dark:text-zinc-300">{row.sensor}</td>
              <td className="px-2 py-1.5 text-right font-mono font-medium text-zinc-900 dark:text-zinc-100">
                {row.value}
              </td>
              <td className="px-2 py-1.5 text-right">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    row.status === 'nominal'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                      : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                  }`}
                >
                  {row.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── AI Insights ──
function AiInsightsWidget() {
  const insights = [
    { icon: 'search', text: 'Mooring Line 1 shows early fatigue signatures', severity: 'warning', conf: 87 },
    { icon: 'check', text: 'Tower vibration within design envelope', severity: 'ok', conf: 96 },
    { icon: 'trendingUp', text: 'Remaining useful life: 18.4 years', severity: 'info', conf: 91 },
    { icon: 'alert', text: 'Wave loading exceeded threshold 3x this hour', severity: 'warning', conf: 79 },
  ];
  return (
    <div className="h-full space-y-1.5 overflow-auto pr-1">
      {insights.map((ins, i) => (
        <div
          key={i}
          className="flex items-start gap-2.5 rounded-lg border border-zinc-200 p-2.5 text-xs dark:border-zinc-800"
        >
          <Glyph name={ins.icon} size={14} className="mt-0.5 shrink-0 text-zinc-400" />
          <div className="min-w-0 flex-1">
            <p className="leading-snug text-zinc-800 dark:text-zinc-200">{ins.text}</p>
            <p className="mt-0.5 text-[10px] text-zinc-400">Confianza: {ins.conf}%</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Map placeholder ──
function MapWidget() {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-center">
        <MapPin className="mx-auto h-5 w-5 text-zinc-400" strokeWidth={1.75} />
        <p className="mt-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">Mapa geográfico</p>
        <p className="mt-0.5 font-mono text-[10px] text-zinc-400">56.0°N · 3.5°E</p>
      </div>
    </div>
  );
}

// ── 3D Model Renderer ──
function GLTFModel({
  url,
  hiddenMeshes,
  onMeshesLoaded,
}: {
  url: string;
  hiddenMeshes: Set<string>;
  onMeshesLoaded: (meshes: string[]) => void;
}) {
  const { scene } = useGLTF(url);
  const clonedScene = useMemo(() => {
    try {
      return scene ? scene.clone() : null;
    } catch (e) {
      console.error('Error cloning scene', e);
      return null;
    }
  }, [scene]);

  useEffect(() => {
    if (!clonedScene) return;
    const meshNames: string[] = [];
    clonedScene.traverse((node: any) => {
      if (node.isMesh && node.name) {
        meshNames.push(node.name);
      }
    });
    onMeshesLoaded(meshNames);
  }, [clonedScene, onMeshesLoaded]);

  useEffect(() => {
    if (!clonedScene) return;
    clonedScene.traverse((node: any) => {
      if (node.isMesh && node.name) {
        node.visible = !hiddenMeshes.has(node.name);
      }
    });
  }, [clonedScene, hiddenMeshes]);

  if (!clonedScene) return null;
  return <primitive object={clonedScene} />;
}

function Model3DWidget({ widget }: { widget: DashboardWidget }) {
  const scenePath = widget.config?.scenePath as string | undefined;
  const autoRotate = widget.config?.autoRotate as boolean | undefined;

  const [meshNames, setMeshNames] = useState<string[]>([]);
  const [hiddenMeshes, setHiddenMeshes] = useState<Set<string>>(new Set());
  const [showPanel, setShowPanel] = useState(false);

  const handleMeshesLoaded = useCallback((names: string[]) => {
    setMeshNames(Array.from(new Set(names)).sort());
  }, []);

  const toggleMesh = (name: string) => {
    setHiddenMeshes(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = (hide: boolean) => {
    if (hide) setHiddenMeshes(new Set(meshNames));
    else setHiddenMeshes(new Set());
  };

  if (!scenePath) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-center">
        <div>
          <Box className="mx-auto h-5 w-5 text-zinc-500" strokeWidth={1.75} />
          <p className="mt-1.5 text-xs font-medium text-zinc-300">Sin modelo 3D</p>
          <p className="mt-0.5 text-[10px] text-zinc-500">Edita el widget para cargar un archivo .glb</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg bg-zinc-950 font-sans">
      <Canvas shadows camera={{ position: [0, 2, 5], fov: 45 }}>
        <Suspense fallback={null}>
          <Stage environment="city" intensity={0.5}>
            <GLTFModel url={scenePath} hiddenMeshes={hiddenMeshes} onMeshesLoaded={handleMeshesLoaded} />
          </Stage>
        </Suspense>
        <OrbitControls autoRotate={!!autoRotate} makeDefault />
      </Canvas>

      <div className="pointer-events-none absolute left-2 top-2 z-10 flex gap-2">
        <span className="rounded border border-zinc-800 bg-zinc-900/90 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
          Modelo 3D
        </span>
      </div>

      <div
        className={`pointer-events-none absolute right-2 top-2 z-10 flex flex-col items-end ${
          showPanel ? 'max-h-[calc(100%-16px)] w-48' : 'w-auto'
        }`}
      >
        <button
          onClick={e => {
            e.stopPropagation();
            setShowPanel(!showPanel);
          }}
          className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/90 text-zinc-300 hover:text-white"
          title="Capas del modelo"
        >
          <Layers className="h-3.5 w-3.5" />
        </button>

        {showPanel && meshNames.length > 0 && (
          <div className="pointer-events-auto mt-1.5 flex max-h-[calc(100vh-100px)] w-full flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-2 py-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Capas</span>
              <div className="flex gap-1">
                <button
                  onClick={() => toggleAll(false)}
                  className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium text-zinc-300 hover:bg-zinc-700"
                >
                  Todas
                </button>
                <button
                  onClick={() => toggleAll(true)}
                  className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium text-zinc-300 hover:bg-zinc-700"
                >
                  Ninguna
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1 custom-scrollbar">
              {meshNames.map(name => {
                const isHidden = hiddenMeshes.has(name);
                return (
                  <button
                    key={name}
                    onClick={() => toggleMesh(name)}
                    className="flex w-full items-center justify-between rounded p-1.5 text-left hover:bg-zinc-800"
                  >
                    <span
                      className={`max-w-[120px] truncate text-[10px] ${
                        isHidden ? 'text-zinc-500 line-through' : 'font-medium text-zinc-200'
                      }`}
                      title={name}
                    >
                      {name}
                    </span>
                    <span className="shrink-0 text-zinc-400">
                      {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function WidgetRenderer({ widget, stream }: WidgetRendererProps) {
  const renderContent = () => {
    switch (widget.type) {
      case 'timeseries':
        return <TimeSeriesWidget widget={widget} stream={stream} />;
      case 'gauge':
        return <GaugeWidget widget={widget} />;
      case 'kpi':
        return <KpiWidget widget={widget} stream={stream} />;
      case 'bar_chart':
        return <BarChartWidget widget={widget} />;
      case 'sensor_table':
        return <SensorTableWidget />;
      case 'ai_insights':
        return <AiInsightsWidget />;
      case 'map':
        return <MapWidget />;
      case 'model3d':
        return <Model3DWidget widget={widget} />;
      default:
        return (
          <div className="flex h-full items-center justify-center text-xs text-zinc-400">
            Tipo de widget desconocido: {widget.type}
          </div>
        );
    }
  };

  return <div className="h-full w-full overflow-hidden">{renderContent()}</div>;
}

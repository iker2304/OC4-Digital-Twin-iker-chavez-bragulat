import { useMemo, Suspense, useState, useEffect, useCallback } from 'react';
import { Layers, Eye, EyeOff } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { useGLTF, OrbitControls, Stage } from '@react-three/drei';
import {
  LineChart, Line, BarChart, Bar, ResponsiveContainer, XAxis, YAxis,
  Tooltip, CartesianGrid,
} from 'recharts';
import type { DashboardWidget, StreamDefinition } from '../../../store/dashboardStore';

interface WidgetRendererProps {
  widget: DashboardWidget;
  stream?: StreamDefinition;
  editMode?: boolean;
}

// ── Helper to generate demo data when no stream is connected ──
function genDemoTimeSeries(n = 30, base = 50, amp = 15) {
  return Array.from({ length: n }, (_, i) => ({
    t: i,
    v: +(base + amp * Math.sin(i * 0.4) + (Math.random() - 0.5) * 5).toFixed(2),
  }));
}

// ── Time Series ──
function TimeSeriesWidget({ widget, stream }: { widget: DashboardWidget; stream?: StreamDefinition }) {
  const color = (widget.config.color as string) || '#3b82f6';
  const [data, setData] = useState(() => genDemoTimeSeries());

  useEffect(() => {
    if (!stream) return;
    
    // For connected streams, we also need to advance the chart even if the value hasn't changed.
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
        const res = await fetch(`http://localhost:8080/persist/stream-values/${widget.streamId}`);
        if (res.ok) {
          const val = await res.json();
          if (val.lastValue !== undefined && val.lastValue !== null) {
            let nextVal = 0;
            // Check if it's an array (like keypoints or bounding boxes)
            if (Array.isArray(val.lastValue)) {
               nextVal = val.lastValue.length;
            } else {
              const numVal = typeof val.lastValue === 'number' ? val.lastValue : parseFloat(String(val.lastValue));
              if (!isNaN(numVal)) {
                nextVal = numVal;
              }
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
    <div className="h-full flex flex-col">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis 
            dataKey="t" 
            tick={{ fontSize: 9, fill: 'var(--chart-axis)' }} 
            hide={!stream} // Hide X axis for demo data as it's just indices
          />
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
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
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
        const res = await fetch(`http://localhost:8080/persist/stream-values/${widget.streamId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.lastValue !== undefined && data.lastValue !== null) {
            const numVal = typeof data.lastValue === 'number' ? data.lastValue : parseFloat(String(data.lastValue));
            if (!isNaN(numVal)) {
              setManualVal(numVal);
            }
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
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <svg width="120" height="80" viewBox="0 0 120 80">
          <path d="M 15 75 A 50 50 0 0 1 105 75" fill="none" stroke="#e5e7eb" strokeWidth="10" strokeLinecap="round" />
          <path
            d="M 15 75 A 50 50 0 0 1 105 75"
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${pct * 157} 157`}
          />
          <line
            x1="60" y1="75"
            x2={60 + 35 * Math.cos((angle - 90) * (Math.PI / 180))}
            y2={75 + 35 * Math.sin((angle - 90) * (Math.PI / 180))}
            stroke={color} strokeWidth="3" strokeLinecap="round"
          />
          <circle cx="60" cy="75" r="5" fill={color} />
        </svg>
        <p className="text-2xl font-black mt-1" style={{ color }}>{val.toFixed(1)}{unit}</p>
        <p className="text-[10px] text-gray-400">{min} – {max}</p>
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
        const res = await fetch(`http://localhost:8080/persist/stream-values/${widget.streamId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.lastValue !== undefined && data.lastValue !== null) {
            const numVal = typeof data.lastValue === 'number' ? data.lastValue : parseFloat(String(data.lastValue));
            if (!isNaN(numVal)) {
              setManualVal(numVal);
            }
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
    <div className="h-full flex flex-col justify-center px-2">
      <p className="text-3xl font-black text-gray-900 dark:text-white tabular-nums">
        {typeof val === 'number' ? val.toFixed(precision) : String(val)}
        <span className="text-lg font-semibold text-gray-400 ml-1">{unit}</span>
      </p>
      {Boolean(widget.config.trend) && !stream && (
        <div className={`flex items-center gap-1 mt-1 text-xs font-semibold ${trend >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
          <span>{trend >= 0 ? '▲' : '▼'}</span>
          <span>{Math.abs(trend).toFixed(1)}% vs last hour</span>
        </div>
      )}
      {stream ? (
        <p className="text-[10px] text-emerald-500 mt-1 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Live stream: {stream.label}
        </p>
      ) : widget.streamId ? (
        <p className="text-[10px] text-blue-400 mt-1 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          Polling stream: {widget.streamId.slice(0, 8)}...
        </p>
      ) : (
        <p className="text-[10px] text-gray-400 mt-1">No stream connected</p>
      )}
    </div>
  );
}

// ── Bar Chart ──
function BarChartWidget({ widget }: { widget: DashboardWidget }) {
  const color = (widget.config.color as string) || '#14b8a6';
  const data = useMemo(() => [
    { label: 'Mooring 1', v: 85 }, { label: 'Mooring 2', v: 72 },
    { label: 'Tower Base', v: 91 }, { label: 'Platform', v: 63 },
    { label: 'Nacelle', v: 78 },
  ], []);
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
    { sensor: 'IMU Roll', value: '2.4°', status: 'nominal', ts: '00:01' },
    { sensor: 'IMU Pitch', value: '1.8°', status: 'nominal', ts: '00:01' },
    { sensor: 'Mooring T1', value: '1234 kN', status: 'warning', ts: '00:00' },
    { sensor: 'Tower Stress', value: '45 MPa', status: 'nominal', ts: '00:01' },
    { sensor: 'Wind Speed', value: '12.3 m/s', status: 'nominal', ts: '00:01' },
    { sensor: 'Wave Height', value: '2.5 m', status: 'nominal', ts: '00:01' },
  ];
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white dark:bg-slate-800">
          <tr className="border-b border-gray-100 dark:border-slate-700">
            <th className="text-left py-2 px-2 font-semibold text-gray-500 dark:text-gray-400">Sensor</th>
            <th className="text-right py-2 px-2 font-semibold text-gray-500 dark:text-gray-400">Value</th>
            <th className="text-right py-2 px-2 font-semibold text-gray-500 dark:text-gray-400">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-50 dark:border-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700/30 transition-colors">
              <td className="py-1.5 px-2 text-gray-700 dark:text-gray-300">{row.sensor}</td>
              <td className="py-1.5 px-2 text-right font-mono text-gray-900 dark:text-white font-semibold">{row.value}</td>
              <td className="py-1.5 px-2 text-right">
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${
                  row.status === 'nominal'
                    ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400'
                    : 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
                }`}>
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
    { icon: '🔍', text: 'Mooring Line 1 shows early fatigue signatures', severity: 'warning', conf: 87 },
    { icon: '✅', text: 'Tower vibration within design envelope', severity: 'ok', conf: 96 },
    { icon: '📈', text: 'Remaining useful life: 18.4 years', severity: 'info', conf: 91 },
    { icon: '⚠️', text: 'Wave loading exceeded threshold 3x this hour', severity: 'warning', conf: 79 },
  ];
  return (
    <div className="h-full overflow-auto space-y-2 pr-1">
      {insights.map((ins, i) => (
        <div
          key={i}
          className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-xs ${
            ins.severity === 'warning'
              ? 'bg-amber-50 border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20'
              : ins.severity === 'ok'
              ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/20'
              : 'bg-blue-50 border-blue-200 dark:bg-blue-500/10 dark:border-blue-500/20'
          }`}
        >
          <span className="text-base leading-none">{ins.icon}</span>
          <div className="flex-1 min-w-0">
            <p className="text-gray-700 dark:text-gray-300 leading-snug">{ins.text}</p>
            <p className="text-[9px] text-gray-400 mt-0.5">Confidence: {ins.conf}%</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Map placeholder ──
function MapWidget() {
  return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700 rounded-xl overflow-hidden relative">
      <div className="absolute inset-0 opacity-20">
        <svg width="100%" height="100%">
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#6366f1" strokeWidth="0.5" />
          </pattern>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      </div>
      <div className="text-center relative z-10">
        <p className="text-4xl">🗺️</p>
        <p className="text-xs font-semibold text-gray-500 mt-2">Map Widget</p>
        <p className="text-[10px] text-gray-400 mt-0.5">56.0°N · 3.5°E</p>
        <div className="mt-2 w-3 h-3 rounded-full bg-blue-500 mx-auto animate-pulse ring-4 ring-blue-500/20" />
      </div>
    </div>
  );
}

// ── 3D Model Renderer ──
function GLTFModel({ url, hiddenMeshes, onMeshesLoaded }: { url: string, hiddenMeshes: Set<string>, onMeshesLoaded: (meshes: string[]) => void }) {
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
    setMeshNames(Array.from(new Set(names)).sort()); // Remove duplicates and sort
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
    if (hide) {
      setHiddenMeshes(new Set(meshNames));
    } else {
      setHiddenMeshes(new Set());
    }
  };

  if (!scenePath) {
    return (
      <div className="h-full flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl overflow-hidden relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(59,130,246,0.1),_transparent_70%)]" />
        <div className="text-center">
          <p className="text-5xl animate-[spin_8s_linear_infinite]">🎨</p>
          <p className="text-xs font-semibold text-white/70 mt-3">No Model Loaded</p>
          <p className="text-[10px] text-white/40 mt-0.5">Edit widget to upload a .glb/.gltf file</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-slate-900 rounded-xl overflow-hidden font-sans relative">
      <Canvas shadows camera={{ position: [0, 2, 5], fov: 45 }}>
        <Suspense fallback={null}>
          <Stage environment="city" intensity={0.5}>
            <GLTFModel url={scenePath} hiddenMeshes={hiddenMeshes} onMeshesLoaded={handleMeshesLoaded} />
          </Stage>
        </Suspense>
        <OrbitControls autoRotate={!!autoRotate} makeDefault />
      </Canvas>
      
      {/* Top Left Indicators */}
      <div className="absolute top-2 left-2 flex gap-2 z-10 pointer-events-none">
        <span className="px-2 py-1 bg-black/50 backdrop-blur-md rounded border border-white/10 text-[9px] font-bold tracking-widest text-white/70 uppercase">Live 3D Model</span>
      </div>

      {/* Components Panel Overlay */}
      <div className={`absolute top-2 right-2 flex flex-col items-end z-10 pointer-events-none transition-all ${showPanel ? 'w-48 max-h-[calc(100%-16px)]' : 'w-auto'}`}>
        <button
          onClick={(e) => { e.stopPropagation(); setShowPanel(!showPanel); }}
          className="pointer-events-auto flex items-center justify-center w-7 h-7 bg-black/50 hover:bg-black/70 backdrop-blur-md border border-white/10 rounded-lg text-white/80 hover:text-white transition-all shadow-xl"
          title="Component Layers"
        >
          <Layers className="w-4 h-4" />
        </button>

        {showPanel && meshNames.length > 0 && (
          <div className="pointer-events-auto mt-2 w-full bg-black/60 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl flex flex-col max-h-[calc(100vh-100px)] overflow-hidden">
            <div className="p-2 border-b border-white/10 flex items-center justify-between shrink-0 bg-white/5">
              <span className="text-[10px] font-bold text-white/90 uppercase tracking-widest">Components</span>
              <div className="flex gap-1">
                <button onClick={() => toggleAll(false)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] text-white/80 transition-all font-semibold">ALL</button>
                <button onClick={() => toggleAll(true)} className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[9px] text-white/80 transition-all font-semibold">NONE</button>
              </div>
            </div>
            <div className="overflow-y-auto custom-scrollbar p-1 flex-1 min-h-0">
              {meshNames.map(name => {
                const isHidden = hiddenMeshes.has(name);
                return (
                  <button
                    key={name}
                    onClick={() => toggleMesh(name)}
                    className="w-full flex items-center justify-between p-1.5 hover:bg-white/10 rounded text-left transition-all group"
                  >
                    <span className={`text-[10px] truncate max-w-[120px] transition-colors ${isHidden ? 'text-white/40 line-through' : 'text-white/90 font-medium'}`} title={name}>
                      {name}
                    </span>
                    <span className="shrink-0 text-white/40 group-hover:text-white/80">
                      {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
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

// ── Main renderer ──
export default function WidgetRenderer({ widget, stream }: WidgetRendererProps) {
  const renderContent = () => {
    switch (widget.type) {
      case 'timeseries': return <TimeSeriesWidget widget={widget} stream={stream} />;
      case 'gauge': return <GaugeWidget widget={widget} />;
      case 'kpi': return <KpiWidget widget={widget} stream={stream} />;
      case 'bar_chart': return <BarChartWidget widget={widget} />;
      case 'sensor_table': return <SensorTableWidget />;
      case 'ai_insights': return <AiInsightsWidget />;
      case 'map': return <MapWidget />;
      case 'model3d': return <Model3DWidget widget={widget} />;
      default: return (
        <div className="h-full flex items-center justify-center text-gray-400 text-xs">
          Unknown widget type: {widget.type}
        </div>
      );
    }
  };

  return (
    <div className="h-full w-full overflow-hidden">
      {renderContent()}
    </div>
  );
}

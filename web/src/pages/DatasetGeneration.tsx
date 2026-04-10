import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import DatasetViewer from '../components/DatasetViewer';

type FieldSchema = {
  name: string;
  type: 'integer' | 'float' | 'categorical' | 'string';
  min?: number;
  max?: number;
  values?: string[];
};

type DatasetConfig = {
  datasetSize: number;
  fieldSchema: FieldSchema[];
  outputFormat: 'jsonl' | 'csv' | 'parquet';
  validationOptions: { strict: boolean; allowNulls: boolean };
  balancing: { enabled: boolean; strategy: 'uniform' | 'weighted' | 'custom' };
  quality: { maxErrorRate: number };
};

type BlenderConfig = {
  numRenders: number;
  resolutionX: number;
  resolutionY: number;
};

type DatasetStatus = {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped' | 'error';
  mode?: 'blender' | 'synthetic';
  runId: string | null;
  startTime: number | null;
  endTime: number | null;
  config: DatasetConfig;
  blenderConfig?: BlenderConfig;
  outputDir?: string | null;
  command?: string | null;
  metrics: {
    processed: number;
    total: number;
    valid: number;
    invalid: number;
    errors: number;
    recordsPerSecond: number;
    elapsedSeconds: number;
    remainingSeconds: number | null;
    progressPercent: number;
    errorRate: number;
  };
  system: { cpu: number; memory: number; disk: number };
  distribution: Record<string, number>;
  samples: Record<string, unknown>[];
  logs: { timestamp: string; level: string; message: string }[];
  history: Array<{
    runId: string;
    startTime: string | null;
    endTime: string | null;
    status: string;
    processed: number;
    total: number;
    errorRate: number;
  }>;
  notifications: { timestamp: string; kind: string; message: string }[];
};

const defaultConfig: DatasetConfig = {
  datasetSize: 5000,
  fieldSchema: [
    { name: 'id', type: 'integer', min: 1, max: 1000000 },
    { name: 'class', type: 'categorical', values: ['A', 'B', 'C'] },
    { name: 'score', type: 'float', min: 0, max: 1 },
  ],
  outputFormat: 'jsonl',
  validationOptions: { strict: true, allowNulls: false },
  balancing: { enabled: false, strategy: 'uniform' },
  quality: { maxErrorRate: 0.02 },
};

const defaultBlenderConfig: BlenderConfig = {
  numRenders: 10000,
  resolutionX: 1280,
  resolutionY: 1280,
};

const formatDuration = (seconds: number | null) => {
  if (seconds === null || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
};

const loadProfiles = (): Array<{ name: string; config: DatasetConfig }> => {
  try {
    const raw = localStorage.getItem('dataset_profiles');
    if (!raw) return [];
    return JSON.parse(raw) as Array<{ name: string; config: DatasetConfig }>;
  } catch {
    return [];
  }
};

const saveProfiles = (profiles: Array<{ name: string; config: DatasetConfig }>) => {
  localStorage.setItem('dataset_profiles', JSON.stringify(profiles));
};

export default function DatasetGeneration() {
  const [status, setStatus] = useState<DatasetStatus | null>(null);
  const [config, setConfig] = useState<DatasetConfig>(defaultConfig);
  const [mode, setMode] = useState<'blender' | 'synthetic'>('blender');
  const [blenderConfig, setBlenderConfig] = useState<BlenderConfig>(defaultBlenderConfig);
  const [errors, setErrors] = useState<string[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);
  const [throughputHistory, setThroughputHistory] = useState<Array<{ timestamp: number; value: number }>>([]);
  const [profiles, setProfiles] = useState<Array<{ name: string; config: DatasetConfig }>>(loadProfiles);
  const [profileName, setProfileName] = useState('');
  const [showViewer, setShowViewer] = useState(false);

  const distributionData = useMemo(
    () =>
      Object.entries(status?.distribution || {}).map(([key, value]) => ({
        name: key,
        value,
      })),
    [status?.distribution]
  );
  const recordsPerSecond = status?.metrics.recordsPerSecond ?? null;

  const validateConfigLocal = (cfg: DatasetConfig) => {
    const issues: string[] = [];
    if (!Number.isInteger(cfg.datasetSize) || cfg.datasetSize <= 0) {
      issues.push('El tamaño del dataset debe ser un entero positivo.');
    }
    if (!cfg.fieldSchema.length) {
      issues.push('Debe definir al menos un campo.');
    }
    cfg.fieldSchema.forEach((field, index) => {
      if (!field.name.trim()) {
        issues.push(`Campo ${index + 1}: nombre requerido.`);
      }
      if (field.type === 'integer' || field.type === 'float') {
        if (field.min === undefined || field.max === undefined) {
          issues.push(`Campo ${field.name || index + 1}: define min y max.`);
        } else if (field.min >= field.max) {
          issues.push(`Campo ${field.name || index + 1}: min debe ser menor que max.`);
        }
      }
      if (field.type === 'categorical') {
        if (!field.values || field.values.length === 0) {
          issues.push(`Campo ${field.name || index + 1}: valores categóricos requeridos.`);
        }
      }
    });
    if (cfg.quality.maxErrorRate < 0 || cfg.quality.maxErrorRate > 0.5) {
      issues.push('La tasa máxima de errores debe estar entre 0 y 0.5.');
    }
    setErrors(issues);
    return issues.length === 0;
  };

  const validateBlenderConfig = (cfg: BlenderConfig) => {
    const issues: string[] = [];
    if (!Number.isInteger(cfg.numRenders) || cfg.numRenders <= 0) {
      issues.push('El número de renders debe ser un entero positivo.');
    }
    if (!Number.isInteger(cfg.resolutionX) || cfg.resolutionX <= 0) {
      issues.push('La resolución X debe ser un entero positivo.');
    }
    if (!Number.isInteger(cfg.resolutionY) || cfg.resolutionY <= 0) {
      issues.push('La resolución Y debe ser un entero positivo.');
    }
    setErrors(issues);
    return issues.length === 0;
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch('http://localhost:8080/dataset/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DatasetStatus;
      setStatus(data);
      if (data.mode) {
        setMode(data.mode);
      }
      if (data.config) {
        setConfig(data.config);
      }
      if (data.blenderConfig) {
        setBlenderConfig(data.blenderConfig);
      }
      setApiError(null);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    fetchStatus();
    const intervalId = window.setInterval(fetchStatus, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (recordsPerSecond === null) return;
    setThroughputHistory((prev) => {
      const next = [...prev, { timestamp: Date.now(), value: recordsPerSecond }].slice(-120);
      return next;
    });
  }, [recordsPerSecond]);

  const startGeneration = async () => {
    if (mode === 'blender') {
      if (!validateBlenderConfig(blenderConfig)) return;
    } else if (!validateConfigLocal(config)) {
      return;
    }
    try {
      const res = await fetch('http://localhost:8080/dataset/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          mode === 'blender'
            ? { mode: 'blender', blenderConfig }
            : { mode: 'synthetic', config }
        ),
      });
      if (!res.ok) {
        const err = await res.json();
        setApiError(JSON.stringify(err));
        return;
      }
      setApiError(null);
      fetchStatus();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  const pauseGeneration = async () => {
    try {
      const res = await fetch('http://localhost:8080/dataset/pause', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetchStatus();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  const resumeGeneration = async () => {
    try {
      const res = await fetch('http://localhost:8080/dataset/resume', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetchStatus();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  const stopGeneration = async () => {
    const confirmed = window.confirm('¿Seguro que deseas detener la generación?');
    if (!confirmed) return;
    try {
      const res = await fetch('http://localhost:8080/dataset/stop', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetchStatus();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveProfile = () => {
    const name = profileName.trim();
    if (!name) return;
    const next = [...profiles.filter((p) => p.name !== name), { name, config }];
    setProfiles(next);
    saveProfiles(next);
    setProfileName('');
  };

  const loadProfile = (name: string) => {
    const found = profiles.find((p) => p.name === name);
    if (!found) return;
    setConfig(found.config);
  };

  const deleteProfile = (name: string) => {
    const next = profiles.filter((p) => p.name !== name);
    setProfiles(next);
    saveProfiles(next);
  };

  const exportReport = async () => {
    try {
      const res = await fetch('http://localhost:8080/dataset/report');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `dataset_report_${data.runId || 'latest'}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateField = (index: number, patch: Partial<FieldSchema>) => {
    setConfig((prev) => {
      const fieldSchema = prev.fieldSchema.map((field, idx) => (idx === index ? { ...field, ...patch } : field));
      return { ...prev, fieldSchema };
    });
  };

  const removeField = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      fieldSchema: prev.fieldSchema.filter((_, idx) => idx !== index),
    }));
  };

  const addField = () => {
    setConfig((prev) => ({
      ...prev,
      fieldSchema: [...prev.fieldSchema, { name: '', type: 'string' }],
    }));
  };

  const isRunning = status?.status === 'running';
  const isPaused = status?.status === 'paused';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">
          <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">Estado en tiempo real</h3>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${isRunning ? 'bg-green-100 text-green-700' : isPaused ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>
                {status?.status || 'cargando'}
              </span>
            </div>
            <div className="mt-4">
              <div className="h-3 w-full bg-gray-200 rounded-full overflow-hidden dark:bg-slate-700">
                <div className="h-full bg-blue-600" style={{ width: `${status?.metrics.progressPercent || 0}%` }} />
              </div>
              <div className="mt-2 text-sm text-gray-600 dark:text-slate-300">
                {status?.metrics.progressPercent?.toFixed(2) || '0.00'}% completado
              </div>
              {status?.outputDir ? <div className="mt-2 text-xs text-gray-500 break-all">Salida: {status.outputDir}</div> : null}
              {status?.command ? <div className="mt-1 text-xs text-gray-500 break-all">Comando: {status.command}</div> : null}
            </div>
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-gray-500 dark:text-slate-400">Tiempo transcurrido</div>
                <div className="font-semibold">{formatDuration(status?.metrics.elapsedSeconds ?? null)}</div>
              </div>
              <div>
                <div className="text-gray-500 dark:text-slate-400">Tiempo restante</div>
                <div className="font-semibold">{formatDuration(status?.metrics.remainingSeconds ?? null)}</div>
              </div>
              <div>
                <div className="text-gray-500 dark:text-slate-400">Velocidad</div>
                <div className="font-semibold">{status?.metrics.recordsPerSecond?.toFixed(2) || '0.00'} reg/s</div>
              </div>
              <div>
                <div className="text-gray-500 dark:text-slate-400">Registros</div>
                <div className="font-semibold">
                  {status?.metrics.processed || 0}/
                  {status?.metrics.total || (mode === 'blender' ? blenderConfig.numRenders : config.datasetSize)}
                </div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-gray-500 dark:text-slate-400">Válidos</div>
                <div className="font-semibold">{status?.metrics.valid || 0}</div>
              </div>
              <div>
                <div className="text-gray-500 dark:text-slate-400">Inválidos</div>
                <div className="font-semibold">{status?.metrics.invalid || 0}</div>
              </div>
              <div>
                <div className="text-gray-500 dark:text-slate-400">Tasa de errores</div>
                <div className="font-semibold">{status?.metrics.errorRate?.toFixed(2) || '0.00'}%</div>
              </div>
              <div>
                <div className="text-gray-500 dark:text-slate-400">CPU / Mem / Disco</div>
                <div className="font-semibold">
                  {status?.system.cpu?.toFixed(1) || '0.0'}% / {status?.system.memory?.toFixed(1) || '0.0'}% /{' '}
                  {status?.system.disk?.toFixed(1) || '0.0'}%
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
            <h3 className="text-lg font-bold mb-4">Controles de ejecución</h3>
            <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
              <span className="text-gray-500 dark:text-slate-400">Modo</span>
              <button
                onClick={() => setMode('blender')}
                disabled={isRunning || isPaused}
                className={`px-3 py-1 rounded ${mode === 'blender' ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-slate-700'}`}
              >
                Blender
              </button>
              <button
                onClick={() => setMode('synthetic')}
                disabled={isRunning || isPaused}
                className={`px-3 py-1 rounded ${mode === 'synthetic' ? 'bg-blue-600 text-white' : 'bg-gray-200 dark:bg-slate-700'}`}
              >
                Sintético
              </button>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={startGeneration}
                disabled={isRunning || isPaused}
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
              >
                Iniciar
              </button>
              <button
                onClick={pauseGeneration}
                disabled={!isRunning}
                className="px-4 py-2 rounded bg-yellow-500 text-white text-sm font-medium disabled:opacity-50"
              >
                Pausar
              </button>
              <button
                onClick={resumeGeneration}
                disabled={!isPaused}
                className="px-4 py-2 rounded bg-green-600 text-white text-sm font-medium disabled:opacity-50"
              >
                Reanudar
              </button>
              <button
                onClick={stopGeneration}
                disabled={!isRunning && !isPaused}
                className="px-4 py-2 rounded bg-red-600 text-white text-sm font-medium disabled:opacity-50"
              >
                Detener
              </button>
              <button
                onClick={exportReport}
                className="px-4 py-2 rounded bg-gray-900 text-white text-sm font-medium"
              >
                Exportar reporte
              </button>
              <button
                onClick={() => setShowViewer(true)}
                className="px-4 py-2 rounded bg-indigo-600 text-white text-sm font-medium"
              >
                Ver Dataset
              </button>
            </div>
            {errors.length > 0 ? (
              <div className="mt-3 text-sm text-red-600 space-y-1">
                {errors.map((err) => (
                  <div key={err}>{err}</div>
                ))}
              </div>
            ) : null}
            {apiError ? <div className="mt-3 text-sm text-red-600">{apiError}</div> : null}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
              <h3 className="text-lg font-bold mb-4">Throughput en tiempo real</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={throughputHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis dataKey="timestamp" tick={false} stroke="var(--chart-axis)" />
                    <YAxis stroke="var(--chart-axis)" />
                    <Tooltip labelFormatter={(label) => new Date(Number(label)).toLocaleTimeString()} />
                    <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
              <h3 className="text-lg font-bold mb-4">Distribución de clases</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={distributionData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis dataKey="name" stroke="var(--chart-axis)" />
                    <YAxis stroke="var(--chart-axis)" />
                    <Tooltip />
                    <Bar dataKey="value" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
            <h3 className="text-lg font-bold mb-4">Muestras de registros</h3>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-slate-400">
                    {status?.samples?.[0]
                      ? Object.keys(status.samples[0]).map((key) => (
                          <th key={key} className="py-2 pr-4">
                            {key}
                          </th>
                        ))
                      : null}
                  </tr>
                </thead>
                <tbody>
                  {status?.samples?.map((row, idx) => (
                    <tr key={idx} className="border-t border-gray-100 dark:border-slate-700">
                      {Object.values(row).map((value, index) => (
                        <td key={index} className="py-2 pr-4">
                          {String(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!status?.samples?.length ? <div className="text-sm text-gray-500">Sin muestras todavía.</div> : null}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
            <h3 className="text-lg font-bold mb-4">Notificaciones</h3>
            <div className="space-y-2 text-sm">
              {(status?.notifications || []).slice(-6).map((note, index) => (
                <div key={`${note.timestamp}-${index}`} className="flex flex-col bg-gray-50 dark:bg-slate-700 p-2 rounded">
                  <span className="font-semibold">{note.kind.toUpperCase()}</span>
                  <span>{note.message}</span>
                  <span className="text-xs text-gray-500">{new Date(note.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
              {!status?.notifications?.length ? <div className="text-gray-500">Sin eventos recientes.</div> : null}
            </div>
          </div>

          <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
            <h3 className="text-lg font-bold mb-4">Historial de ejecuciones</h3>
            <div className="overflow-auto text-sm">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-slate-400">
                    <th className="py-2 pr-3">Run</th>
                    <th className="py-2 pr-3">Estado</th>
                    <th className="py-2 pr-3">Procesados</th>
                    <th className="py-2 pr-3">Errores</th>
                  </tr>
                </thead>
                <tbody>
                  {(status?.history || []).slice(-6).map((run) => (
                    <tr key={run.runId} className="border-t border-gray-100 dark:border-slate-700">
                      <td className="py-2 pr-3">{run.runId.slice(0, 8)}</td>
                      <td className="py-2 pr-3">{run.status}</td>
                      <td className="py-2 pr-3">
                        {run.processed}/{run.total}
                      </td>
                      <td className="py-2 pr-3">{run.errorRate?.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!status?.history?.length ? <div className="text-gray-500">Sin ejecuciones previas.</div> : null}
            </div>
          </div>

          <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
            <h3 className="text-lg font-bold mb-4">Logs detallados</h3>
            <div className="space-y-2 text-xs max-h-64 overflow-auto">
              {(status?.logs || []).slice(-40).map((log, index) => (
                <div key={`${log.timestamp}-${index}`} className="border border-gray-100 dark:border-slate-700 rounded p-2">
                  <div className="text-gray-500">{new Date(log.timestamp).toLocaleTimeString()}</div>
                  <div className="font-semibold">{log.level}</div>
                  <div>{log.message}</div>
                </div>
              ))}
              {!status?.logs?.length ? <div className="text-gray-500">Sin logs todavía.</div> : null}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white p-5 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
        <h3 className="text-lg font-bold">Configuración</h3>
        {mode === 'blender' ? (
          <div className="mt-4 space-y-4">
            <div className="text-sm text-gray-600 dark:text-slate-300">
              Cada ejecución crea una carpeta nueva dentro de data/synthetic_dataset/pose.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-gray-600 dark:text-slate-300">Número de renders</label>
                <input
                  type="number"
                  min={1}
                  value={blenderConfig.numRenders}
                  onChange={(e) => setBlenderConfig({ ...blenderConfig, numRenders: Number(e.target.value) })}
                  className="mt-1 w-full px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600 dark:text-slate-300">Resolución X</label>
                <input
                  type="number"
                  min={1}
                  value={blenderConfig.resolutionX}
                  onChange={(e) => setBlenderConfig({ ...blenderConfig, resolutionX: Number(e.target.value) })}
                  className="mt-1 w-full px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600 dark:text-slate-300">Resolución Y</label>
                <input
                  type="number"
                  min={1}
                  value={blenderConfig.resolutionY}
                  onChange={(e) => setBlenderConfig({ ...blenderConfig, resolutionY: Number(e.target.value) })}
                  className="mt-1 w-full px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                />
              </div>
            </div>
            {status?.outputDir ? <div className="text-xs text-gray-500 break-all">Salida actual: {status.outputDir}</div> : null}
          </div>
        ) : (
          <>
            <div className="mt-4 flex items-center justify-between gap-4">
              <h4 className="text-base font-semibold">Perfiles sintéticos</h4>
              <div className="flex items-center gap-2">
                <input
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="Nombre del perfil"
                  className="px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                />
                <button onClick={saveProfile} className="px-3 py-2 rounded bg-blue-600 text-white text-sm font-medium">
                  Guardar perfil
                </button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              {profiles.map((profile) => (
                <div key={profile.name} className="flex items-center gap-2 bg-gray-100 dark:bg-slate-700 px-3 py-1 rounded-full">
                  <button onClick={() => loadProfile(profile.name)} className="font-semibold">
                    {profile.name}
                  </button>
                  <button onClick={() => deleteProfile(profile.name)} className="text-red-500">
                    ×
                  </button>
                </div>
              ))}
              {!profiles.length ? <span className="text-gray-500">Sin perfiles guardados.</span> : null}
            </div>

            <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-gray-600 dark:text-slate-300">Tamaño del dataset</label>
                  <input
                    type="number"
                    min={1}
                    value={config.datasetSize}
                    onChange={(e) => setConfig({ ...config, datasetSize: Number(e.target.value) })}
                    className="mt-1 w-full px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-600 dark:text-slate-300">Formato de salida</label>
                  <select
                    value={config.outputFormat}
                    onChange={(e) => setConfig({ ...config, outputFormat: e.target.value as DatasetConfig['outputFormat'] })}
                    className="mt-1 w-full px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                  >
                    <option value="jsonl">JSONL</option>
                    <option value="csv">CSV</option>
                    <option value="parquet">Parquet</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={config.validationOptions.strict}
                      onChange={(e) =>
                        setConfig({ ...config, validationOptions: { ...config.validationOptions, strict: e.target.checked } })
                      }
                    />
                    Validación estricta
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={config.validationOptions.allowNulls}
                      onChange={(e) =>
                        setConfig({ ...config, validationOptions: { ...config.validationOptions, allowNulls: e.target.checked } })
                      }
                    />
                    Permitir nulos
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={config.balancing.enabled}
                      onChange={(e) => setConfig({ ...config, balancing: { ...config.balancing, enabled: e.target.checked } })}
                    />
                    Balanceo activo
                  </label>
                  <select
                    value={config.balancing.strategy}
                    onChange={(e) =>
                      setConfig({ ...config, balancing: { ...config.balancing, strategy: e.target.value as DatasetConfig['balancing']['strategy'] } })
                    }
                    className="px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                  >
                    <option value="uniform">Uniforme</option>
                    <option value="weighted">Ponderado</option>
                    <option value="custom">Personalizado</option>
                  </select>
                </div>

                <div>
                  <label className="text-sm text-gray-600 dark:text-slate-300">Calidad: tasa máxima de errores</label>
                  <input
                    type="number"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={config.quality.maxErrorRate}
                    onChange={(e) => setConfig({ ...config, quality: { maxErrorRate: Number(e.target.value) } })}
                    className="mt-1 w-full px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <h4 className="text-base font-semibold">Estructura de campos</h4>
                  <button onClick={addField} className="px-3 py-1 rounded bg-gray-200 text-sm dark:bg-slate-700">
                    Añadir campo
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  {config.fieldSchema.map((field, index) => (
                    <div key={`${field.name}-${index}`} className="border border-gray-100 dark:border-slate-700 rounded-lg p-3 space-y-2">
                      <div className="grid grid-cols-2 gap-3">
                        <input
                          value={field.name}
                          onChange={(e) => updateField(index, { name: e.target.value })}
                          placeholder="Nombre del campo"
                          className="px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                        />
                        <select
                          value={field.type}
                          onChange={(e) => updateField(index, { type: e.target.value as FieldSchema['type'] })}
                          className="px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                        >
                          <option value="integer">Integer</option>
                          <option value="float">Float</option>
                          <option value="categorical">Categorical</option>
                          <option value="string">String</option>
                        </select>
                      </div>
                      {(field.type === 'integer' || field.type === 'float') && (
                        <div className="grid grid-cols-2 gap-3">
                          <input
                            type="number"
                            value={field.min ?? ''}
                            onChange={(e) => updateField(index, { min: Number(e.target.value) })}
                            placeholder="Min"
                            className="px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                          />
                          <input
                            type="number"
                            value={field.max ?? ''}
                            onChange={(e) => updateField(index, { max: Number(e.target.value) })}
                            placeholder="Max"
                            className="px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                          />
                        </div>
                      )}
                      {field.type === 'categorical' && (
                        <input
                          value={field.values?.join(',') || ''}
                          onChange={(e) =>
                            updateField(index, { values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })
                          }
                          placeholder="Valores separados por comas"
                          className="px-3 py-2 rounded border border-gray-200 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                        />
                      )}
                      <div className="flex justify-end">
                        <button onClick={() => removeField(index)} className="text-xs text-red-500">
                          Eliminar campo
                        </button>
                      </div>
                    </div>
                  ))}
                  {!config.fieldSchema.length ? <div className="text-sm text-gray-500">Añade campos para generar datos.</div> : null}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      {showViewer && <DatasetViewer onClose={() => setShowViewer(false)} />}
    </div>
  );
}

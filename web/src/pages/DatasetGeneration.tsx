import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Play, Pause, Square, Download, FolderOpen, Plus, Split, Sparkles, Save, X,
} from 'lucide-react';
import DatasetViewer from '../components/DatasetViewer';
import { API_BASE_URL } from '../config/api';
import { Badge, Button, Card, CardHeader, PageHeader, Stat, Tabs } from '../components/ui';

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
  const [pageSection, setPageSection] = useState<'monitor' | 'config' | 'yaml'>('monitor');

  const [datasetsList, setDatasetsList] = useState<Array<{
    name: string;
    trainImages: number;
    valImages: number;
    rawImages: number;
    totalImages: number;
  }>>([]);
  const [activeDatasetName, setActiveDatasetName] = useState<string>('Floating platform.v1i.yolov11');
  const [newDatasetName, setNewDatasetName] = useState<string>('');
  const [newDatasetKeypoints, setNewDatasetKeypoints] = useState<number>(11);
  const [yamlConfigs, setYamlConfigs] = useState<Record<string, any>>({});
  const [selectedYamlTab, setSelectedYamlTab] = useState<string>('annotation.yaml');
  const [yamlText, setYamlText] = useState<string>('');
  const [yamlSaveMsg, setYamlSaveMsg] = useState<string | null>(null);

  const fetchDatasetsAndYaml = async () => {
    try {
      const [dsRes, cfgRes] = await Promise.all([
        fetch(`${API_BASE_URL}/dataset/list`),
        fetch(`${API_BASE_URL}/dataset/configs`),
      ]);
      if (dsRes.ok) {
        const d = await dsRes.json();
        setDatasetsList(d.datasets || []);
      }
      if (cfgRes.ok) {
        const c = await cfgRes.json();
        setYamlConfigs(c || {});
        if (c && c['annotation.yaml'] && !yamlText) {
          setYamlText(JSON.stringify(c['annotation.yaml'], null, 2));
        }
      }
    } catch {
      // ignore
    }
  };

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
      const res = await fetch(`${API_BASE_URL}/dataset/status`);
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
    fetchDatasetsAndYaml();
    const intervalId = window.setInterval(fetchStatus, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const handleCreateDataset = async () => {
    if (!newDatasetName.trim()) return;
    try {
      const res = await fetch(`${API_BASE_URL}/dataset/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newDatasetName.trim(),
          keypointsCount: newDatasetKeypoints,
          numTrain: 16,
          numVal: 4,
        }),
      });
      if (res.ok) {
        setActiveDatasetName(newDatasetName.trim());
        setNewDatasetName('');
        fetchDatasetsAndYaml();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleQuickGenerateSamples = async () => {
    try {
      await fetch(`${API_BASE_URL}/dataset/generate-samples`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset: activeDatasetName,
          numTrain: 12,
          numVal: 4,
          keypointsCount: newDatasetKeypoints,
        }),
      });
      fetchDatasetsAndYaml();
    } catch (e) {
      console.error(e);
    }
  };

  const handleQuickSplit = async () => {
    try {
      await fetch(`${API_BASE_URL}/dataset/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset: activeDatasetName, trainRatio: 0.8 }),
      });
      fetchDatasetsAndYaml();
    } catch (e) {
      console.error(e);
    }
  };

  const handleSelectYamlTab = (tab: string) => {
    setSelectedYamlTab(tab);
    setYamlText(JSON.stringify(yamlConfigs[tab] || {}, null, 2));
  };

  const handleSaveYamlConfig = async () => {
    try {
      const parsed = JSON.parse(yamlText);
      const res = await fetch(`${API_BASE_URL}/dataset/configs/${selectedYamlTab}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: parsed }),
      });
      if (res.ok) {
        setYamlSaveMsg(`Guardado ${selectedYamlTab} correctamente`);
        fetchDatasetsAndYaml();
        setTimeout(() => setYamlSaveMsg(null), 3000);
      }
    } catch {
      setYamlSaveMsg('Error: JSON inválido');
    }
  };

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
      const res = await fetch(`${API_BASE_URL}/dataset/start`, {
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
      const res = await fetch(`${API_BASE_URL}/dataset/pause`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fetchStatus();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  };

  const resumeGeneration = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/dataset/resume`, { method: 'POST' });
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
      const res = await fetch(`${API_BASE_URL}/dataset/stop`, { method: 'POST' });
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
      const res = await fetch(`${API_BASE_URL}/dataset/report`);
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
    <div className="space-y-6 pb-8">
      <PageHeader
        eyebrow="Datos y Visión Artificial"
        title="Gestión y Generación de Datasets (YOLO Pose y BBox)"
        description="Crea colecciones de datos para distintos gemelos digitales, genera poses sintéticas, divide particiones Train/Val y edita etiquetas."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={activeDatasetName}
              onChange={(e) => setActiveDatasetName(e.target.value)}
              className="ui-input text-xs py-1.5 w-auto"
            >
              {datasetsList.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} ({d.trainImages} train / {d.valImages} val)
                </option>
              ))}
            </select>
            <Button variant="secondary" size="sm" onClick={handleQuickGenerateSamples}>
              <Sparkles className="w-3.5 h-3.5" /> Generar muestras
            </Button>
            <Button variant="secondary" size="sm" onClick={handleQuickSplit}>
              <Split className="w-3.5 h-3.5" /> Split 80/20
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowViewer(true)}>
              <FolderOpen className="w-3.5 h-3.5" /> Explorador y editor
            </Button>
          </div>
        }
      />

      {/* Quick Create Dataset Bar */}
      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 flex-1">
          <span className="ui-eyebrow shrink-0">Nuevo dataset:</span>
          <input
            type="text"
            value={newDatasetName}
            onChange={(e) => setNewDatasetName(e.target.value)}
            placeholder="Nombre (ej. RobotArm_Pose_v1, Bridge_SHM_v1)..."
            className="ui-input text-xs max-w-xs"
          />
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-gray-500">Keypoints:</span>
            <input
              type="number"
              min={1}
              max={64}
              value={newDatasetKeypoints}
              onChange={(e) => setNewDatasetKeypoints(Number(e.target.value))}
              className="ui-input text-xs font-mono w-16"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={handleCreateDataset}>
            <Plus className="w-3.5 h-3.5" /> Crear con muestras iniciales
          </Button>
        </div>

        <Tabs
          value={pageSection}
          onChange={setPageSection}
          items={[
            { value: 'monitor', label: 'Ejecución y métricas' },
            { value: 'config', label: 'Configuración de generador' },
            { value: 'yaml', label: 'Pipeline YAML' },
          ]}
        />
      </Card>

      {pageSection === 'monitor' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-6">
            {/* Execution Controls + Progress */}
            <Card className="p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Estado del generador</h3>
                  <Badge variant={isRunning ? 'success' : isPaused ? 'warning' : 'neutral'}>
                    {status?.status || 'inactivo'}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="inline-flex rounded-md border border-gray-200 dark:border-slate-800 p-0.5 mr-2">
                    <button
                      onClick={() => setMode('blender')}
                      disabled={isRunning || isPaused}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        mode === 'blender'
                          ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                          : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
                      }`}
                    >
                      Blender
                    </button>
                    <button
                      onClick={() => setMode('synthetic')}
                      disabled={isRunning || isPaused}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        mode === 'synthetic'
                          ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                          : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
                      }`}
                    >
                      Sintético
                    </button>
                  </div>

                  <Button variant="primary" size="sm" onClick={startGeneration} disabled={isRunning || isPaused}>
                    <Play className="w-3.5 h-3.5" /> Iniciar
                  </Button>
                  <Button variant="secondary" size="sm" onClick={pauseGeneration} disabled={!isRunning}>
                    <Pause className="w-3.5 h-3.5" /> Pausar
                  </Button>
                  <Button variant="secondary" size="sm" onClick={resumeGeneration} disabled={!isPaused}>
                    <Play className="w-3.5 h-3.5" /> Reanudar
                  </Button>
                  <Button variant="danger" size="sm" onClick={stopGeneration} disabled={!isRunning && !isPaused}>
                    <Square className="w-3.5 h-3.5" /> Detener
                  </Button>
                  <Button variant="ghost" size="sm" onClick={exportReport}>
                    <Download className="w-3.5 h-3.5" /> Reporte
                  </Button>
                </div>
              </div>

              <div>
                <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden dark:bg-slate-800">
                  <div
                    className="h-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${status?.metrics.progressPercent || 0}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-gray-500">
                  <span>{status?.metrics.progressPercent?.toFixed(2) || '0.00'}% completado</span>
                  {status?.outputDir && <span className="font-mono truncate max-w-md">Salida: {status.outputDir}</span>}
                </div>
              </div>

              {errors.length > 0 && (
                <div className="text-xs text-red-600 space-y-1">
                  {errors.map((err) => (
                    <div key={err}>{err}</div>
                  ))}
                </div>
              )}
              {apiError && <div className="text-xs text-red-600">{apiError}</div>}

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
                <Stat
                  label="Transcurrido / Restante"
                  value={formatDuration(status?.metrics.elapsedSeconds ?? null)}
                  sub={`Restante: ${formatDuration(status?.metrics.remainingSeconds ?? null)}`}
                />
                <Stat
                  label="Velocidad"
                  value={`${status?.metrics.recordsPerSecond?.toFixed(2) || '0.00'} reg/s`}
                  sub={`${status?.metrics.processed || 0} / ${status?.metrics.total || (mode === 'blender' ? blenderConfig.numRenders : config.datasetSize)}`}
                />
                <Stat
                  label="Válidos / Inválidos"
                  value={`${status?.metrics.valid || 0} / ${status?.metrics.invalid || 0}`}
                  sub={`Tasa error: ${status?.metrics.errorRate?.toFixed(2) || '0.00'}%`}
                />
                <Stat
                  label="CPU / Mem / Disco"
                  value={`${status?.system.cpu?.toFixed(1) || '0.0'}%`}
                  sub={`Mem ${status?.system.memory?.toFixed(1) || '0.0'}% · Disco ${status?.system.disk?.toFixed(1) || '0.0'}%`}
                />
              </div>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="p-5">
                <h3 className="ui-eyebrow mb-4">Throughput en tiempo real</h3>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={throughputHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                      <XAxis dataKey="timestamp" tick={false} stroke="var(--chart-axis)" />
                      <YAxis stroke="var(--chart-axis)" fontSize={11} />
                      <Tooltip labelFormatter={(label) => new Date(Number(label)).toLocaleTimeString()} />
                      <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={1.75} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>
              <Card className="p-5">
                <h3 className="ui-eyebrow mb-4">Distribución de clases</h3>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={distributionData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                      <XAxis dataKey="name" stroke="var(--chart-axis)" fontSize={11} />
                      <YAxis stroke="var(--chart-axis)" fontSize={11} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#10b981" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </div>

            <Card className="p-5">
              <h3 className="ui-eyebrow mb-3">Muestras de registros</h3>
              <div className="overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200 dark:border-slate-800">
                      {status?.samples?.[0]
                        ? Object.keys(status.samples[0]).map((key) => (
                            <th key={key} className="py-2 pr-4 font-medium">
                              {key}
                            </th>
                          ))
                        : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                    {status?.samples?.map((row, idx) => (
                      <tr key={idx}>
                        {Object.values(row).map((value, index) => (
                          <td key={index} className="py-2 pr-4 font-mono">
                            {String(value)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!status?.samples?.length && <div className="text-xs text-gray-500 py-4">Sin muestras todavía.</div>}
              </div>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="p-5">
              <h3 className="ui-eyebrow mb-3">Historial de ejecuciones</h3>
              <div className="overflow-auto text-xs">
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200 dark:border-slate-800">
                      <th className="py-2 pr-3 font-medium">Run</th>
                      <th className="py-2 pr-3 font-medium">Estado</th>
                      <th className="py-2 pr-3 font-medium">Procesados</th>
                      <th className="py-2 pr-3 font-medium">Errores</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                    {(status?.history || []).slice(-6).map((run) => (
                      <tr key={run.runId}>
                        <td className="py-2 pr-3 font-mono">{run.runId.slice(0, 8)}</td>
                        <td className="py-2 pr-3">{run.status}</td>
                        <td className="py-2 pr-3 font-mono">
                          {run.processed}/{run.total}
                        </td>
                        <td className="py-2 pr-3 font-mono">{run.errorRate?.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!status?.history?.length && <div className="text-xs text-gray-500 py-2">Sin ejecuciones previas.</div>}
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="ui-eyebrow mb-3">Notificaciones recientes</h3>
              <div className="space-y-2 text-xs">
                {(status?.notifications || []).slice(-6).map((note, index) => (
                  <div key={`${note.timestamp}-${index}`} className="flex flex-col bg-gray-50 dark:bg-slate-800/60 p-2.5 rounded-md border border-gray-100 dark:border-slate-800">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="font-semibold text-gray-900 dark:text-white">{note.kind.toUpperCase()}</span>
                      <span className="text-[10px] font-mono text-gray-400">{new Date(note.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <span className="text-gray-600 dark:text-gray-300">{note.message}</span>
                  </div>
                ))}
                {!status?.notifications?.length && <div className="text-xs text-gray-500">Sin eventos recientes.</div>}
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="ui-eyebrow mb-3">Logs detallados</h3>
              <div className="space-y-1.5 text-xs max-h-64 overflow-auto font-mono">
                {(status?.logs || []).slice(-40).map((log, index) => (
                  <div key={`${log.timestamp}-${index}`} className="border-b border-gray-100 dark:border-slate-800 pb-1.5">
                    <span className="text-gray-400 mr-2">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span className="font-semibold mr-1.5">{log.level}:</span>
                    <span className="text-gray-700 dark:text-gray-300">{log.message}</span>
                  </div>
                ))}
                {!status?.logs?.length && <div className="text-xs text-gray-500 font-sans">Sin logs todavía.</div>}
              </div>
            </Card>
          </div>
        </div>
      )}

      {pageSection === 'config' && (
        <Card className="p-6">
          <CardHeader title="Parámetros de generación" subtitle={mode === 'blender' ? 'Configuración de renderizado sintético en Blender' : 'Esquema y reglas del generador tabular sintético'} />
          {mode === 'blender' ? (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">
                Cada ejecución crea una carpeta nueva dentro de <code className="font-mono">data/synthetic_dataset/pose</code>.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="ui-label">Número de renders</label>
                  <input
                    type="number"
                    min={1}
                    value={blenderConfig.numRenders}
                    onChange={(e) => setBlenderConfig({ ...blenderConfig, numRenders: Number(e.target.value) })}
                    className="ui-input font-mono"
                  />
                </div>
                <div>
                  <label className="ui-label">Resolución X (px)</label>
                  <input
                    type="number"
                    min={1}
                    value={blenderConfig.resolutionX}
                    onChange={(e) => setBlenderConfig({ ...blenderConfig, resolutionX: Number(e.target.value) })}
                    className="ui-input font-mono"
                  />
                </div>
                <div>
                  <label className="ui-label">Resolución Y (px)</label>
                  <input
                    type="number"
                    min={1}
                    value={blenderConfig.resolutionY}
                    onChange={(e) => setBlenderConfig({ ...blenderConfig, resolutionY: Number(e.target.value) })}
                    className="ui-input font-mono"
                  />
                </div>
              </div>
              {status?.outputDir && <div className="text-xs text-gray-500 font-mono break-all">Salida actual: {status.outputDir}</div>}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-gray-200 dark:border-slate-800">
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Perfiles guardados</h4>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    {profiles.map((profile) => (
                      <div key={profile.name} className="inline-flex items-center gap-1.5 bg-gray-100 dark:bg-slate-800 px-2.5 py-1 rounded-md border border-gray-200 dark:border-slate-700">
                        <button onClick={() => loadProfile(profile.name)} className="font-medium text-gray-800 dark:text-gray-200">
                          {profile.name}
                        </button>
                        <button onClick={() => deleteProfile(profile.name)} className="text-gray-400 hover:text-red-500">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {!profiles.length && <span className="text-gray-400">Sin perfiles guardados.</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="Nombre del perfil"
                    className="ui-input text-xs w-48"
                  />
                  <Button variant="secondary" size="sm" onClick={saveProfile}>
                    <Save className="w-3.5 h-3.5" /> Guardar perfil
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="ui-label">Tamaño del dataset</label>
                    <input
                      type="number"
                      min={1}
                      value={config.datasetSize}
                      onChange={(e) => setConfig({ ...config, datasetSize: Number(e.target.value) })}
                      className="ui-input font-mono"
                    />
                  </div>

                  <div>
                    <label className="ui-label">Formato de salida</label>
                    <select
                      value={config.outputFormat}
                      onChange={(e) => setConfig({ ...config, outputFormat: e.target.value as DatasetConfig['outputFormat'] })}
                      className="ui-input"
                    >
                      <option value="jsonl">JSONL</option>
                      <option value="csv">CSV</option>
                      <option value="parquet">Parquet</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={config.validationOptions.strict}
                        onChange={(e) =>
                          setConfig({ ...config, validationOptions: { ...config.validationOptions, strict: e.target.checked } })
                        }
                      />
                      Validación estricta
                    </label>
                    <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
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

                  <div className="grid grid-cols-2 gap-3 items-center">
                    <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
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
                      className="ui-input text-xs"
                    >
                      <option value="uniform">Uniforme</option>
                      <option value="weighted">Ponderado</option>
                      <option value="custom">Personalizado</option>
                    </select>
                  </div>

                  <div>
                    <label className="ui-label">Calidad: tasa máxima de errores</label>
                    <input
                      type="number"
                      min={0}
                      max={0.5}
                      step={0.01}
                      value={config.quality.maxErrorRate}
                      onChange={(e) => setConfig({ ...config, quality: { maxErrorRate: Number(e.target.value) } })}
                      className="ui-input font-mono"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Estructura de campos</h4>
                    <Button variant="secondary" size="sm" onClick={addField}>
                      <Plus className="w-3.5 h-3.5" /> Añadir campo
                    </Button>
                  </div>
                  <div className="space-y-3">
                    {config.fieldSchema.map((field, index) => (
                      <div key={`${field.name}-${index}`} className="border border-gray-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
                        <div className="grid grid-cols-2 gap-3">
                          <input
                            value={field.name}
                            onChange={(e) => updateField(index, { name: e.target.value })}
                            placeholder="Nombre del campo"
                            className="ui-input text-xs"
                          />
                          <select
                            value={field.type}
                            onChange={(e) => updateField(index, { type: e.target.value as FieldSchema['type'] })}
                            className="ui-input text-xs"
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
                              className="ui-input text-xs font-mono"
                            />
                            <input
                              type="number"
                              value={field.max ?? ''}
                              onChange={(e) => updateField(index, { max: Number(e.target.value) })}
                              placeholder="Max"
                              className="ui-input text-xs font-mono"
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
                            className="ui-input text-xs"
                          />
                        )}
                        <div className="flex justify-end">
                          <button onClick={() => removeField(index)} className="text-xs text-red-600 hover:underline">
                            Eliminar campo
                          </button>
                        </div>
                      </div>
                    ))}
                    {!config.fieldSchema.length && <div className="text-xs text-gray-500">Añade campos para generar datos.</div>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      {pageSection === 'yaml' && (
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Configuración avanzada del pipeline (src/config/*.yaml)</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Personaliza las escenas Blender, objetos y keypoints de anotación o parámetros de randomización.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {['annotation.yaml', 'blender.yaml', 'randomization.yaml', 'main.yaml'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => handleSelectYamlTab(tab)}
                  className={`px-2.5 py-1 rounded-md text-xs font-mono font-medium transition-colors border ${
                    selectedYamlTab === tab
                      ? 'bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100'
                      : 'bg-gray-50 dark:bg-slate-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-slate-700'
                  }`}
                >
                  {tab}
                </button>
              ))}
              <Button variant="primary" size="sm" onClick={handleSaveYamlConfig}>
                <Save className="w-3.5 h-3.5" /> Guardar {selectedYamlTab}
              </Button>
            </div>
          </div>
          {yamlSaveMsg && (
            <div className="mb-3 text-xs px-3 py-1.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60">
              {yamlSaveMsg}
            </div>
          )}
          <textarea
            value={yamlText}
            onChange={(e) => setYamlText(e.target.value)}
            rows={14}
            className="ui-input font-mono text-xs"
          />
        </Card>
      )}

      {showViewer && (
        <DatasetViewer
          onClose={() => setShowViewer(false)}
          initialDataset={activeDatasetName}
        />
      )}
    </div>
  );
}

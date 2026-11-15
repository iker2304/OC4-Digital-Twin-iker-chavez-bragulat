import { useEffect, useState } from 'react';
import {
  Play, Square, RefreshCw, CheckCircle2, Sliders, Layers,
  Terminal, Image as ImageIcon, Award, Cpu, Database, Plus, Trash2, Save,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useProfileStore } from '../store/profileStore';
import { API_BASE_URL } from '../config/api';
import { Badge, Button, Card, CardHeader, PageHeader, Stat } from '../components/ui';
import { Glyph } from '../components/ui/Glyph';

interface TrainingMetricsRow {
  epoch: number;
  train_box_loss?: number;
  train_pose_loss?: number;
  train_kobj_loss?: number;
  train_cls_loss?: number;
  val_box_loss?: number;
  val_pose_loss?: number;
  map50_box?: number;
  map50_95_box?: number;
  map50_pose?: number;
  map50_95_pose?: number;
  lr?: number;
}

interface TrainingRunInfo {
  name: string;
  path: string;
  hasResults: boolean;
  hasBestWeights: boolean;
  bestWeightsPath: string | null;
  lastModified: number;
}

interface TrainingArtifact {
  name: string;
  path: string;
}

export const TrainingPage = () => {
  const activeProfile = useProfileStore(s => s.getActiveProfile());
  const updateProfile = useProfileStore(s => s.updateProfile);

  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'stopped' | 'failed'>('idle');
  const [mode, setMode] = useState<string>('auto');
  const [selectedRun, setSelectedRun] = useState<string>('');
  const [currentEpoch, setCurrentEpoch] = useState<number>(0);
  const [totalEpochs, setTotalEpochs] = useState<number>(50);
  const [runs, setRuns] = useState<TrainingRunInfo[]>([]);
  const [history, setHistory] = useState<TrainingMetricsRow[]>([]);
  const [artifacts, setArtifacts] = useState<TrainingArtifact[]>([]);
  const [logs, setLogs] = useState<{ timestamp: string; message: string }[]>([]);
  const [datasets, setDatasets] = useState<{ name: string; trainImages: number; valImages: number }[]>([]);
  const [models, setModels] = useState<{ baseModels: any[]; trainedModels: any[] }>({
    baseModels: [],
    trainedModels: [],
  });
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [assignedSuccess, setAssignedSuccess] = useState<string | null>(null);

  const [config, setConfig] = useState<any>({
    paths: {
      dataset_dir: 'data/datasets/Floating platform.v1i.yolov11',
      base_model: 'data/models/pretrained/yolo11n-pose.pt',
      output_dir: 'data/models/CV/pose',
    },
    dataset: {
      kpt_shape: [11, 3],
      names: { 0: 'floating_platform' },
    },
    training: {
      run_name: 'yolo11-pose-custom',
      epochs: 30,
      imgsz: 640,
      batch: 8,
      lr0: 0.0005,
      patience: 20,
      pose: 15.0,
      kobj: 2.0,
      mosaic: 1.0,
      degrees: 10.0,
      fliplr: 0.5,
    },
    hardware: {
      device: 0,
      workers: 4,
    },
  });

  const [newClassName, setNewClassName] = useState('');

  const fetchAllData = async () => {
    try {
      const [statusRes, dsRes, modelsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/training/status`),
        fetch(`${API_BASE_URL}/dataset/list`),
        fetch(`${API_BASE_URL}/api/training/models`),
      ]);

      if (statusRes.ok) {
        const sData = await statusRes.json();
        setStatus(sData.status || 'idle');
        setSelectedRun(sData.runName || '');
        setCurrentEpoch(sData.currentEpoch || 0);
        setTotalEpochs(sData.totalEpochs || 50);
        setRuns(sData.runs || []);
        setHistory(sData.metricsHistory || []);
        setArtifacts(sData.artifacts || []);
        setLogs(sData.logs || []);
      }

      if (dsRes.ok) {
        const dData = await dsRes.json();
        if (dData.datasets) setDatasets(dData.datasets);
      }

      if (modelsRes.ok) {
        const mData = await modelsRes.json();
        setModels(mData);
      }
    } catch (e) {
      console.error('Error fetching training status:', e);
    }
  };

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/training/config`)
      .then(r => r.json())
      .then(data => {
        if (data && data.paths) setConfig(data);
      })
      .catch(() => {});

    fetchAllData();
    const interval = setInterval(fetchAllData, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleSaveConfig = async () => {
    try {
      await fetch(`${API_BASE_URL}/api/training/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleStartTraining = async () => {
    await handleSaveConfig();
    try {
      await fetch(`${API_BASE_URL}/api/training/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, config }),
      });
      fetchAllData();
    } catch (e) {
      console.error('Failed to start training', e);
    }
  };

  const handleStopTraining = async () => {
    try {
      await fetch(`${API_BASE_URL}/api/training/stop`, { method: 'POST' });
      fetchAllData();
    } catch (e) {
      console.error('Failed to stop training', e);
    }
  };

  const handleSelectRun = async (runName: string) => {
    setSelectedRun(runName);
    try {
      const res = await fetch(`${API_BASE_URL}/api/training/select-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runName }),
      });
      if (res.ok) {
        const data = await res.json();
        setHistory(data.metricsHistory || []);
        setArtifacts(data.artifacts || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleAssignModelToActiveTwin = (weightsPath: string) => {
    if (!activeProfile) return;
    const kptCount = Number(config.dataset?.kpt_shape?.[0]) || 11;
    const classNames = Object.values(config.dataset?.names || { 0: 'floating_platform' }).map(String);

    updateProfile(activeProfile.id, {
      config: {
        ...activeProfile.config,
        aiConfig: {
          ...activeProfile.config.aiConfig,
          yoloModelPath: weightsPath,
          numKeypoints: kptCount,
          classNames,
        },
      },
    });
    setAssignedSuccess(`Modelo ${weightsPath} asignado a "${activeProfile.name}"`);
    setTimeout(() => setAssignedSuccess(null), 4000);
  };

  const addClassName = () => {
    if (!newClassName.trim()) return;
    const currentNames = { ...(config.dataset?.names || {}) };
    const nextIdx = Object.keys(currentNames).length;
    currentNames[nextIdx] = newClassName.trim();
    setConfig({
      ...config,
      dataset: { ...config.dataset, names: currentNames },
    });
    setNewClassName('');
  };

  const removeClassName = (key: string) => {
    const currentNames = { ...(config.dataset?.names || {}) };
    delete currentNames[key];
    const reindexed: Record<number, string> = {};
    Object.values(currentNames).forEach((v, i) => {
      reindexed[i] = String(v);
    });
    setConfig({
      ...config,
      dataset: { ...config.dataset, names: reindexed },
    });
  };

  const latestMetrics = history.length > 0 ? history[history.length - 1] : null;
  const progressPct = totalEpochs > 0 ? Math.min(100, Math.round((currentEpoch / totalEpochs) * 100)) : 0;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        eyebrow="Visión Artificial"
        title="Entrenamiento de Modelos IA (YOLO Pose y Detección)"
        description="Configura hiperparámetros, entrena redes de estimación de pose 6-DOF y vincúlalas a cualquier gemelo digital."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={mode}
              onChange={e => setMode(e.target.value)}
              disabled={status === 'running'}
              className="ui-input text-xs py-1.5 w-auto"
            >
              <option value="auto">Modo Auto (Ultralytics / Simulación)</option>
              <option value="simulated">Entrenamiento Rápido Interactivo</option>
              <option value="real">Subproceso PyTorch / Ultralytics</option>
            </select>

            {status === 'running' ? (
              <Button variant="danger" onClick={handleStopTraining}>
                <Square className="w-3.5 h-3.5" />
                Detener entrenamiento
              </Button>
            ) : (
              <Button variant="primary" onClick={handleStartTraining}>
                <Play className="w-3.5 h-3.5" />
                Iniciar entrenamiento
              </Button>
            )}
          </div>
        }
      />

      {assignedSuccess && (
        <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-300 px-4 py-2.5 rounded-lg flex items-center gap-2 text-xs font-medium">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{assignedSuccess}</span>
        </div>
      )}

      {/* Top KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="ui-eyebrow">Estado / Época</span>
            <Badge
              variant={
                status === 'running'
                  ? 'warning'
                  : status === 'completed'
                  ? 'success'
                  : status === 'failed'
                  ? 'danger'
                  : 'neutral'
              }
            >
              {status}
            </Badge>
          </div>
          <div className="text-xl font-semibold font-mono text-gray-900 dark:text-white">
            {currentEpoch} <span className="text-xs text-gray-400 font-normal">/ {totalEpochs}</span>
          </div>
          <div className="w-full h-1.5 bg-gray-100 dark:bg-slate-800 rounded-full mt-3 overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </Card>

        <Stat
          label="mAP@50 (Pose Keypoints)"
          value={
            latestMetrics?.map50_pose !== undefined
              ? `${(latestMetrics.map50_pose * 100).toFixed(2)}%`
              : '—'
          }
          sub={
            latestMetrics?.map50_95_pose !== undefined
              ? `mAP@50-95: ${(latestMetrics.map50_95_pose * 100).toFixed(1)}%`
              : 'mAP@50-95: —'
          }
        />

        <Stat
          label="mAP@50 (Bounding Box)"
          value={
            latestMetrics?.map50_box !== undefined
              ? `${(latestMetrics.map50_box * 100).toFixed(2)}%`
              : '—'
          }
          sub={
            latestMetrics?.map50_95_box !== undefined
              ? `mAP@50-95: ${(latestMetrics.map50_95_box * 100).toFixed(1)}%`
              : 'mAP@50-95: —'
          }
        />

        <Stat
          label="Pose Loss (Train / Val)"
          value={latestMetrics?.train_pose_loss !== undefined ? latestMetrics.train_pose_loss.toFixed(3) : '—'}
          sub={`Val Pose Loss: ${latestMetrics?.val_pose_loss !== undefined ? latestMetrics.val_pose_loss.toFixed(3) : '—'}`}
        />

        <Card className="p-4">
          <div className="ui-eyebrow mb-1.5">Gemelo activo vinculado</div>
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white truncate">
            {activeProfile ? (
              <>
                <Glyph name={activeProfile.icon} className="w-4 h-4 text-gray-500 shrink-0" />
                <span className="truncate">{activeProfile.name}</span>
              </>
            ) : (
              'Ninguno'
            )}
          </div>
          <div
            className="text-[11px] text-gray-500 font-mono truncate mt-1"
            title={activeProfile?.config.aiConfig?.yoloModelPath}
          >
            {activeProfile?.config.aiConfig?.yoloModelPath || 'best.pt'}
          </div>
        </Card>
      </div>

      {/* Main Grid: Left Configurator (5 cols) | Right Live Charts & Runs (7 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Training Configuration Form */}
        <Card className="lg:col-span-5 p-5 space-y-4">
          <CardHeader
            title="Configuración (train.yaml)"
            icon={<Sliders className="w-4 h-4" />}
            action={
              <Button variant="secondary" size="sm" onClick={handleSaveConfig}>
                <Save className="w-3.5 h-3.5" /> Guardar YAML
              </Button>
            }
          />

          <div className="space-y-4 text-xs">
            {/* Run Name & Dataset */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="ui-label">Nombre del experimento (Run)</label>
                <input
                  type="text"
                  value={config.training?.run_name || ''}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, run_name: e.target.value },
                    })
                  }
                  className="ui-input text-xs"
                  placeholder="yolo11-pose-v2"
                />
              </div>

              <div>
                <label className="ui-label flex items-center gap-1">
                  <Database className="w-3 h-3 text-gray-400" /> Dataset de entrenamiento
                </label>
                <select
                  value={config.paths?.dataset_dir || ''}
                  onChange={e =>
                    setConfig({
                      ...config,
                      paths: { ...config.paths, dataset_dir: e.target.value },
                    })
                  }
                  className="ui-input text-xs"
                >
                  {datasets.map(ds => (
                    <option key={ds.name} value={`data/datasets/${ds.name}`}>
                      {ds.name} ({ds.trainImages} train / {ds.valImages} val)
                    </option>
                  ))}
                  {datasets.length === 0 && (
                    <option value="data/datasets/Floating platform.v1i.yolov11">
                      Floating platform.v1i.yolov11
                    </option>
                  )}
                </select>
              </div>
            </div>

            {/* Base Pretrained Model & Keypoint Shape */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="ui-label">Modelo base preentrenado (.pt)</label>
                <select
                  value={config.paths?.base_model || ''}
                  onChange={e =>
                    setConfig({
                      ...config,
                      paths: { ...config.paths, base_model: e.target.value },
                    })
                  }
                  className="ui-input text-xs"
                >
                  {models.baseModels.map((m: any) => (
                    <option key={m.path} value={m.path}>
                      {m.name} ({m.sizeMb} MB)
                    </option>
                  ))}
                  <option value="data/models/pretrained/yolo11n-pose.pt">yolo11n-pose.pt (Nano)</option>
                  <option value="data/models/pretrained/yolo11m-pose.pt">yolo11m-pose.pt (Medium)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="ui-label">Nº Keypoints</label>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={config.dataset?.kpt_shape?.[0] ?? 11}
                    onChange={e =>
                      setConfig({
                        ...config,
                        dataset: {
                          ...config.dataset,
                          kpt_shape: [Number(e.target.value), config.dataset?.kpt_shape?.[1] ?? 3],
                        },
                      })
                    }
                    className="ui-input text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="ui-label">Dimensión</label>
                  <select
                    value={config.dataset?.kpt_shape?.[1] ?? 3}
                    onChange={e =>
                      setConfig({
                        ...config,
                        dataset: {
                          ...config.dataset,
                          kpt_shape: [config.dataset?.kpt_shape?.[0] ?? 11, Number(e.target.value)],
                        },
                      })
                    }
                    className="ui-input text-xs"
                  >
                    <option value={2}>2 (x, y)</option>
                    <option value={3}>3 (x, y, vis)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Hyperparameters Grid */}
            <div className="grid grid-cols-3 gap-3 pt-1">
              <div>
                <label className="ui-label">Épocas</label>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={config.training?.epochs ?? 30}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, epochs: Number(e.target.value) },
                    })
                  }
                  className="ui-input text-xs font-mono"
                />
              </div>
              <div>
                <label className="ui-label">Batch Size</label>
                <input
                  type="number"
                  min={1}
                  max={128}
                  value={config.training?.batch ?? 8}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, batch: Number(e.target.value) },
                    })
                  }
                  className="ui-input text-xs font-mono"
                />
              </div>
              <div>
                <label className="ui-label">Resolución (imgsz)</label>
                <input
                  type="number"
                  step={32}
                  value={config.training?.imgsz ?? 640}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, imgsz: Number(e.target.value) },
                    })
                  }
                  className="ui-input text-xs font-mono"
                />
              </div>
              <div>
                <label className="ui-label">Learning Rate</label>
                <input
                  type="number"
                  step={0.0001}
                  value={config.training?.lr0 ?? 0.0005}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, lr0: Number(e.target.value) },
                    })
                  }
                  className="ui-input text-xs font-mono"
                />
              </div>
              <div>
                <label className="ui-label">Pose Gain</label>
                <input
                  type="number"
                  step={0.5}
                  value={config.training?.pose ?? 15.0}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, pose: Number(e.target.value) },
                    })
                  }
                  className="ui-input text-xs font-mono"
                />
              </div>
              <div>
                <label className="ui-label">Patience</label>
                <input
                  type="number"
                  value={config.training?.patience ?? 20}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, patience: Number(e.target.value) },
                    })
                  }
                  className="ui-input text-xs font-mono"
                />
              </div>
            </div>

            {/* Object Classes Editor */}
            <div className="pt-3 border-t border-gray-200 dark:border-slate-800">
              <label className="ui-label">Clases del gemelo digital (dataset.names)</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {Object.entries(config.dataset?.names || {}).map(([idx, clsName]) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-gray-200 text-xs"
                  >
                    <span className="text-gray-400 font-mono">{idx}:</span> {String(clsName)}
                    <button
                      onClick={() => removeClassName(idx)}
                      className="text-gray-400 hover:text-red-500"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newClassName}
                  onChange={e => setNewClassName(e.target.value)}
                  placeholder="Añadir clase (ej. wind_turbine, robot_joint)..."
                  className="ui-input flex-1 text-xs"
                />
                <Button variant="secondary" size="sm" onClick={addClassName}>
                  <Plus className="w-3.5 h-3.5" /> Añadir
                </Button>
              </div>
            </div>

            {/* Hardware */}
            <div className="grid grid-cols-2 gap-3 pt-3 border-t border-gray-200 dark:border-slate-800">
              <div>
                <label className="ui-label flex items-center gap-1">
                  <Cpu className="w-3 h-3 text-gray-400" /> Dispositivo (GPU ID o cpu)
                </label>
                <input
                  type="text"
                  value={String(config.hardware?.device ?? '0')}
                  onChange={e =>
                    setConfig({
                      ...config,
                      hardware: { ...config.hardware, device: e.target.value },
                    })
                  }
                  className="ui-input text-xs font-mono"
                />
              </div>
              <div>
                <label className="ui-label">Workers Dataloader</label>
                <input
                  type="number"
                  min={0}
                  max={16}
                  value={config.hardware?.workers ?? 4}
                  onChange={e =>
                    setConfig({
                      ...config,
                      hardware: { ...config.hardware, workers: Number(e.target.value) },
                    })
                  }
                  className="ui-input text-xs font-mono"
                />
              </div>
            </div>
          </div>
        </Card>

        {/* Right: Live Curves & Runs Selector */}
        <div className="lg:col-span-7 space-y-6">
          {/* Runs Selector & Model Assignment Bar */}
          <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Layers className="w-4 h-4 text-gray-400" />
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Historial de runs:</span>
              <select
                value={selectedRun}
                onChange={e => handleSelectRun(e.target.value)}
                className="ui-input text-xs py-1.5 w-auto"
              >
                {runs.map(r => (
                  <option key={r.name} value={r.name}>
                    {r.name} {r.hasBestWeights ? '(best.pt)' : ''}
                  </option>
                ))}
              </select>
              <Button variant="ghost" size="sm" onClick={fetchAllData} title="Refrescar">
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>

            {selectedRun && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  handleAssignModelToActiveTwin(`data/models/CV/pose/${selectedRun}/weights/best.pt`)
                }
              >
                <Award className="w-3.5 h-3.5" />
                Asignar ({selectedRun}) al gemelo activo
              </Button>
            )}
          </Card>

          {/* Charts Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4">
              <h3 className="ui-eyebrow mb-3">Evolución de pérdidas (Box & Pose Loss)</h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis dataKey="epoch" stroke="#64748b" fontSize={11} />
                    <YAxis stroke="#64748b" fontSize={11} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', color: '#f4f4f5', fontSize: 12 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="train_pose_loss" name="Train Pose Loss" stroke="#3b82f6" strokeWidth={1.75} dot={false} />
                    <Line type="monotone" dataKey="val_pose_loss" name="Val Pose Loss" stroke="#f59e0b" strokeWidth={1.75} dot={false} />
                    <Line type="monotone" dataKey="train_box_loss" name="Train Box Loss" stroke="#64748b" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="ui-eyebrow mb-3">Precisión media (mAP@50 & mAP@50-95)</h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis dataKey="epoch" stroke="#64748b" fontSize={11} />
                    <YAxis domain={[0, 1]} stroke="#64748b" fontSize={11} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', color: '#f4f4f5', fontSize: 12 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="map50_pose" name="mAP@50 Pose" stroke="#10b981" strokeWidth={1.75} dot={false} />
                    <Line type="monotone" dataKey="map50_95_pose" name="mAP@50-95 Pose" stroke="#3b82f6" strokeWidth={1.75} dot={false} />
                    <Line type="monotone" dataKey="map50_box" name="mAP@50 Box" stroke="#f59e0b" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          {/* Artifacts & Console Logs */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4">
              <h3 className="ui-eyebrow mb-3 flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5" />
                Artefactos del modelo ({artifacts.length})
              </h3>
              {artifacts.length === 0 ? (
                <p className="text-xs text-gray-500 py-8 text-center">
                  No hay gráficas de validación en este run todavía.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {artifacts.map(art => (
                      <button
                        key={art.name}
                        onClick={() => setSelectedArtifact(art.path)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                          selectedArtifact === art.path
                            ? 'bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100'
                            : 'bg-gray-50 dark:bg-slate-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-slate-700 hover:bg-gray-100'
                        }`}
                      >
                        {art.name}
                      </button>
                    ))}
                  </div>
                  {selectedArtifact && (
                    <div className="rounded-md overflow-hidden border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-950 p-1">
                      <img
                        src={`${API_BASE_URL}${selectedArtifact}`}
                        alt="Training artifact"
                        className="w-full h-44 object-contain rounded"
                      />
                    </div>
                  )}
                </div>
              )}
            </Card>

            <Card className="p-4 flex flex-col">
              <h3 className="ui-eyebrow mb-3 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5" />
                Consola de entrenamiento en vivo
              </h3>
              <div className="flex-1 h-48 bg-gray-950 border border-gray-800 rounded-md p-3 overflow-y-auto font-mono text-[11px] space-y-1">
                {logs.length === 0 ? (
                  <div className="text-gray-500">
                    Listo para iniciar entrenamiento. Pulsa "Iniciar entrenamiento" para ejecutar épocas...
                  </div>
                ) : (
                  logs.map((l, idx) => (
                    <div key={idx} className="text-gray-300 leading-relaxed">
                      <span className="text-gray-500 mr-2">
                        [{new Date(l.timestamp).toLocaleTimeString()}]
                      </span>
                      <span>{l.message}</span>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

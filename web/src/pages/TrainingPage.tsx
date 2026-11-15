import { useEffect, useState } from 'react';
import {
  Brain, Play, Square, RefreshCw, CheckCircle2, Sliders, Layers,
  Terminal, Image as ImageIcon, Award, Cpu, Database, Plus, Trash2
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { useProfileStore } from '../store/profileStore';
import { API_BASE_URL } from '../config/api';

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

  // Configurable train.yaml state
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
    <div className="h-full overflow-y-auto pr-2 space-y-6 pb-8">
      {/* Header Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-400">
              <Brain className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                Centro de Entrenamiento IA (YOLO Pose & Detección)
              </h1>
              <p className="text-sm text-slate-400">
                Configura hiperparámetros, entrena redes de estimación de pose 6-DOF y vincúlalas a cualquier Gemelo Digital.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Training Mode Selector */}
          <select
            value={mode}
            onChange={e => setMode(e.target.value)}
            disabled={status === 'running'}
            className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-purple-500"
          >
            <option value="auto">Modo Auto (Ultralytics / Simulación)</option>
            <option value="simulated">Entrenamiento Rápido Interactivo</option>
            <option value="real">Subproceso PyTorch / Ultralytics</option>
          </select>

          {status === 'running' ? (
            <button
              onClick={handleStopTraining}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold shadow-lg transition-all"
            >
              <Square className="w-4 h-4" />
              Detener Entrenamiento
            </button>
          ) : (
            <button
              onClick={handleStartTraining}
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white text-sm font-semibold shadow-lg transition-all"
            >
              <Play className="w-4 h-4" />
              Iniciar Entrenamiento
            </button>
          )}
        </div>
      </div>

      {assignedSuccess && (
        <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 px-4 py-3 rounded-xl flex items-center gap-2 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{assignedSuccess}</span>
        </div>
      )}

      {/* Top KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-semibold mb-1">Estado / Época</div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold text-white">
              {currentEpoch} <span className="text-sm text-slate-500 font-normal">/ {totalEpochs}</span>
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-semibold uppercase ${
                status === 'running'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse'
                  : status === 'completed'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-slate-800 text-slate-400'
              }`}
            >
              {status}
            </span>
          </div>
          <div className="w-full h-1.5 bg-slate-800 rounded-full mt-3 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-semibold mb-1">mAP@50 (Pose Keypoints)</div>
          <div className="text-2xl font-bold text-emerald-400">
            {latestMetrics?.map50_pose !== undefined
              ? `${(latestMetrics.map50_pose * 100).toFixed(2)}%`
              : '—'}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            mAP@50-95: {latestMetrics?.map50_95_pose !== undefined ? `${(latestMetrics.map50_95_pose * 100).toFixed(1)}%` : '—'}
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-semibold mb-1">mAP@50 (Bounding Box)</div>
          <div className="text-2xl font-bold text-blue-400">
            {latestMetrics?.map50_box !== undefined
              ? `${(latestMetrics.map50_box * 100).toFixed(2)}%`
              : '—'}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            mAP@50-95: {latestMetrics?.map50_95_box !== undefined ? `${(latestMetrics.map50_95_box * 100).toFixed(1)}%` : '—'}
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-semibold mb-1">Pose Loss (Train / Val)</div>
          <div className="text-2xl font-bold text-purple-400">
            {latestMetrics?.train_pose_loss !== undefined ? latestMetrics.train_pose_loss.toFixed(3) : '—'}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Val Pose Loss: {latestMetrics?.val_pose_loss !== undefined ? latestMetrics.val_pose_loss.toFixed(3) : '—'}
          </div>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase font-semibold mb-1">Gemelo Activo Vinculado</div>
          <div className="text-sm font-bold text-white truncate">
            {activeProfile ? `${activeProfile.icon} ${activeProfile.name}` : 'Ninguno'}
          </div>
          <div className="text-[11px] text-slate-400 font-mono truncate mt-1" title={activeProfile?.config.aiConfig?.yoloModelPath}>
            {activeProfile?.config.aiConfig?.yoloModelPath || 'best.pt'}
          </div>
        </div>
      </div>

      {/* Main Grid: Left Configurator (5 cols) | Right Live Charts & Runs (7 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Training Configuration Form */}
        <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-purple-400" />
              Configuración de Entrenamiento (train.yaml)
            </h2>
            <button
              onClick={handleSaveConfig}
              className="text-xs px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-blue-400 border border-slate-700 transition-colors"
            >
              Guardar YAML
            </button>
          </div>

          <div className="space-y-4 text-xs">
            {/* Run Name & Dataset */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1 font-medium">Nombre del Experimento (Run)</label>
                <input
                  type="text"
                  value={config.training?.run_name || ''}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, run_name: e.target.value },
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                  placeholder="yolo11-pose-v2"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1 font-medium flex items-center gap-1">
                  <Database className="w-3.5 h-3.5 text-blue-400" /> Dataset de Entrenamiento
                </label>
                <select
                  value={config.paths?.dataset_dir || ''}
                  onChange={e =>
                    setConfig({
                      ...config,
                      paths: { ...config.paths, dataset_dir: e.target.value },
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
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
                <label className="block text-slate-400 mb-1 font-medium">Modelo Base Pre-entrenado (.pt)</label>
                <select
                  value={config.paths?.base_model || ''}
                  onChange={e =>
                    setConfig({
                      ...config,
                      paths: { ...config.paths, base_model: e.target.value },
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
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
                  <label className="block text-slate-400 mb-1 font-medium">Nº Keypoints</label>
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
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Dim (2D/3D vis)</label>
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
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                  >
                    <option value={2}>2 (x, y)</option>
                    <option value={3}>3 (x, y, visible)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Hyperparameters Grid */}
            <div className="grid grid-cols-3 gap-3 pt-1">
              <div>
                <label className="block text-slate-400 mb-1">Épocas (Epochs)</label>
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
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Batch Size</label>
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
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Resolución (imgsz)</label>
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
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Learning Rate (lr0)</label>
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
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Pose Gain</label>
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
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Patience (EarlyStop)</label>
                <input
                  type="number"
                  value={config.training?.patience ?? 20}
                  onChange={e =>
                    setConfig({
                      ...config,
                      training: { ...config.training, patience: Number(e.target.value) },
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
              </div>
            </div>

            {/* Object Classes Editor */}
            <div className="pt-2 border-t border-slate-800">
              <label className="block text-slate-400 mb-2 font-medium">
                Clases del Gemelo Digital (dataset.names)
              </label>
              <div className="flex flex-wrap gap-2 mb-2">
                {Object.entries(config.dataset?.names || {}).map(([idx, clsName]) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-300 text-xs"
                  >
                    <span className="text-purple-400 font-mono">{idx}:</span> {String(clsName)}
                    <button
                      onClick={() => removeClassName(idx)}
                      className="text-slate-400 hover:text-red-400"
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
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
                <button
                  onClick={addClassName}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Añadir
                </button>
              </div>
            </div>

            {/* Hardware */}
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800">
              <div>
                <label className="block text-slate-400 mb-1 flex items-center gap-1">
                  <Cpu className="w-3.5 h-3.5 text-cyan-400" /> Dispositivo (GPU ID o cpu)
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
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Workers Dataloader</label>
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
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-white"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Right: Live Curves & Runs Selector */}
        <div className="lg:col-span-7 space-y-6">
          {/* Runs Selector & Model Assignment Bar */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Layers className="w-4 h-4 text-blue-400" />
              <span className="text-xs font-semibold text-slate-300 uppercase">Historial de Runs:</span>
              <select
                value={selectedRun}
                onChange={e => handleSelectRun(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white"
              >
                {runs.map(r => (
                  <option key={r.name} value={r.name}>
                    {r.name} {r.hasBestWeights ? '✓ (best.pt)' : ''}
                  </option>
                ))}
              </select>
              <button
                onClick={fetchAllData}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                title="Refrescar"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {selectedRun && (
              <button
                onClick={() =>
                  handleAssignModelToActiveTwin(`data/models/CV/pose/${selectedRun}/weights/best.pt`)
                }
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-medium transition-colors"
              >
                <Award className="w-3.5 h-3.5" />
                Asignar Modelo ({selectedRun}) al Gemelo Activo
              </button>
            )}
          </div>

          {/* Charts Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Loss Chart */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
                Evolución de Pérdidas (Box & Pose Loss)
              </h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="epoch" stroke="#64748b" fontSize={11} />
                    <YAxis stroke="#64748b" fontSize={11} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', fontSize: 12 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="train_pose_loss" name="Train Pose Loss" stroke="#a855f7" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="val_pose_loss" name="Val Pose Loss" stroke="#ec4899" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="train_box_loss" name="Train Box Loss" stroke="#3b82f6" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* mAP Precision Chart */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
                Precisión Media (mAP@50 & mAP@50-95)
              </h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="epoch" stroke="#64748b" fontSize={11} />
                    <YAxis domain={[0, 1]} stroke="#64748b" fontSize={11} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', fontSize: 12 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="map50_pose" name="mAP@50 Pose" stroke="#10b981" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="map50_95_pose" name="mAP@50-95 Pose" stroke="#06b6d4" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="map50_box" name="mAP@50 Box" stroke="#f59e0b" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Artifacts & Console Logs */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Training Artifacts Viewer */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3 flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-purple-400" />
                Artefactos y Curvas del Modelo ({artifacts.length})
              </h3>
              {artifacts.length === 0 ? (
                <p className="text-xs text-slate-500 py-8 text-center">
                  No hay gráficas de validación en este run todavía.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {artifacts.map(art => (
                      <button
                        key={art.name}
                        onClick={() => setSelectedArtifact(art.path)}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                          selectedArtifact === art.path
                            ? 'bg-purple-600 text-white'
                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        {art.name}
                      </button>
                    ))}
                  </div>
                  {selectedArtifact && (
                    <div className="rounded-lg overflow-hidden border border-slate-800 bg-slate-950 p-1">
                      <img
                        src={`${API_BASE_URL}${selectedArtifact}`}
                        alt="Training artifact"
                        className="w-full h-44 object-contain rounded"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Live Training Console */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex flex-col">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                Consola de Entrenamiento en Vivo
              </h3>
              <div className="flex-1 h-48 bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-y-auto font-mono text-[11px] space-y-1">
                {logs.length === 0 ? (
                  <div className="text-slate-600">
                    Listo para iniciar entrenamiento. Pulsa "Iniciar Entrenamiento" para ejecutar épocas...
                  </div>
                ) : (
                  logs.map((l, idx) => (
                    <div key={idx} className="text-slate-300 leading-relaxed">
                      <span className="text-slate-500 mr-2">
                        [{new Date(l.timestamp).toLocaleTimeString()}]
                      </span>
                      <span>{l.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

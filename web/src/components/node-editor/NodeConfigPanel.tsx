import { X, Info, Upload, CheckCircle, AlertCircle, Loader, Camera, RefreshCw, Check } from 'lucide-react';
import { useNodeEditorStore, CATEGORY_META } from '../../store/nodeEditorStore';
import { useState } from 'react';
import type { Node } from '@xyflow/react';
import { API_BASE_URL } from '../../config/api';
import { Glyph } from '../ui/Glyph';

interface NodeConfigPanelProps {
  node: Node;
  onClose: () => void;
}

const DATA_TYPE_COLORS: Record<string, string> = {
  json: '#6366f1',
  number: '#10b981',
  string: '#f59e0b',
  any: '#94a3b8',
  signal: '#8b5cf6',
  image: '#ec4899',
  mesh: '#f97316',
};

type UploadState = 'idle' | 'uploading' | 'success' | 'error';

export default function NodeConfigPanel({ node, onClose }: NodeConfigPanelProps) {
  const { updateNodeConfig } = useNodeEditorStore();
  const [uploadStates, setUploadStates] = useState<Record<string, UploadState>>({});
  const [uploadMessages, setUploadMessages] = useState<Record<string, string>>({});
  const [cameras, setCameras] = useState<{ index: number; resolution: string; fps: number }[]>([]);
  const [camerasLoading, setCamerasLoading] = useState(false);

  const data = node.data as {
    type: string;
    category: string;
    label: string;
    icon: string;
    color: string;
    inputs?: { id: string; label: string; dataType: string }[];
    outputs?: { id: string; label: string; dataType: string }[];
    config?: Record<string, unknown>;
  };

  const color = data.color || '#3b82f6';
  const category = data.category as keyof typeof CATEGORY_META;
  const catMeta = CATEGORY_META[category];
  const inputs = data.inputs ?? [];
  const outputs = data.outputs ?? [];
  const config = data.config ?? {};

  const handleConfigChange = (key: string, value: unknown) => {
    updateNodeConfig(node.id, { [key]: value });
  };

  return (
    <div className="w-72 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-800 flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 rounded-md bg-gray-100 dark:bg-slate-800 flex items-center justify-center text-gray-700 dark:text-gray-200 shrink-0"
            style={{ borderLeft: `3px solid ${color}` }}
          >
            <Glyph name={data.icon} className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-xs font-semibold text-gray-900 dark:text-white truncate">{data.label}</h3>
            {catMeta && (
              <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                <Glyph name={catMeta.icon} className="w-3 h-3" />
                {catMeta.label}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Ports section */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-800">
          <p className="ui-eyebrow mb-2">Puertos</p>
          <div className="space-y-1.5">
            {inputs.map(p => (
              <div key={p.id} className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: DATA_TYPE_COLORS[p.dataType] || '#94a3b8' }}
                />
                <span className="text-xs text-gray-600 dark:text-gray-300">{p.label}</span>
                <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 font-mono">
                  in · {p.dataType}
                </span>
              </div>
            ))}
            {outputs.map(p => (
              <div key={p.id} className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: DATA_TYPE_COLORS[p.dataType] || '#94a3b8' }}
                />
                <span className="text-xs text-gray-600 dark:text-gray-300">{p.label}</span>
                <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 font-mono">
                  out · {p.dataType}
                </span>
              </div>
            ))}
            {inputs.length === 0 && outputs.length === 0 && (
              <p className="text-xs text-gray-400">Sin puertos definidos</p>
            )}
          </div>
        </div>

        {/* Config section */}
        <div className="px-4 py-3">
          <p className="ui-eyebrow mb-3">Configuración</p>
          <div className="space-y-3">
            {Object.entries(config).map(([key, value]) => (
              <div key={key}>
                <label className="ui-label capitalize">
                  {key.replace(/_/g, ' ')}
                </label>
                {key === 'cameraIndex' ? (
                  <div className="space-y-2">
                    <div className="flex gap-1.5">
                      <input
                        type="number"
                        min={0}
                        value={Number(value)}
                        onChange={e => handleConfigChange(key, parseInt(e.target.value) || 0)}
                        className="ui-input text-xs"
                      />
                      <button
                        onClick={async () => {
                          setCamerasLoading(true);
                          try {
                            const res = await fetch(`${API_BASE_URL}/api/flow/cameras`);
                            if (res.ok) {
                              const d = await res.json();
                              setCameras(d.cameras || []);
                            }
                          } catch { /* ignore */ } finally {
                            setCamerasLoading(false);
                          }
                        }}
                        className="px-2.5 py-1.5 rounded-md bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors shrink-0"
                        title="Detectar cámaras"
                      >
                        {camerasLoading
                          ? <Loader className="w-3.5 h-3.5 text-gray-600 dark:text-gray-300 animate-spin" />
                          : <RefreshCw className="w-3.5 h-3.5 text-gray-600 dark:text-gray-300" />}
                      </button>
                    </div>
                    {cameras.length > 0 && (
                      <div className="space-y-1">
                        {cameras.map(cam => (
                          <button
                            key={cam.index}
                            onClick={() => handleConfigChange(key, cam.index)}
                            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors border ${
                              Number(value) === cam.index
                                ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-800'
                                : 'bg-gray-50 dark:bg-slate-800/50 border-gray-200 dark:border-slate-700 hover:border-gray-300'
                            }`}
                          >
                            <Camera className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                            <span className="text-xs font-medium text-gray-700 dark:text-gray-200">Cámara {cam.index}</span>
                            <span className="ml-auto text-[10px] text-gray-400 font-mono">{cam.resolution} · {cam.fps.toFixed(0)}fps</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {cameras.length === 0 && !camerasLoading && (
                      <p className="text-[11px] text-gray-400">Pulsa actualizar para detectar cámaras</p>
                    )}
                  </div>
                ) : typeof value === 'boolean' ? (
                  <button
                    onClick={() => handleConfigChange(key, !value)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                      value
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60'
                        : 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-slate-800 dark:text-gray-400 dark:border-slate-700'
                    }`}
                  >
                    {value && <Check className="w-3 h-3" />}
                    {value ? 'Activado' : 'Desactivado'}
                  </button>
                ) : typeof value === 'number' ? (
                  <input
                    type="number"
                    value={value}
                    onChange={e => handleConfigChange(key, parseFloat(e.target.value) || 0)}
                    className="ui-input text-xs font-mono"
                  />
                ) : key === 'uploadedFile' || key === 'modelFile' ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={String(value)}
                      onChange={e => handleConfigChange(key, e.target.value)}
                      className="ui-input text-xs font-mono"
                      placeholder="uploads/model.onnx"
                    />
                    <label className={`flex items-center justify-center gap-2 px-3 py-2 border border-dashed rounded-md cursor-pointer transition-colors ${
                      uploadStates[key] === 'success'
                        ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30'
                        : uploadStates[key] === 'error'
                        ? 'border-red-400 bg-red-50 dark:bg-red-950/30'
                        : uploadStates[key] === 'uploading'
                        ? 'border-blue-300 bg-blue-50 dark:bg-blue-950/30 cursor-wait'
                        : 'border-gray-300 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                    }`}>
                      {uploadStates[key] === 'uploading' ? (
                        <Loader className="w-3.5 h-3.5 text-blue-600 animate-spin" />
                      ) : uploadStates[key] === 'success' ? (
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                      ) : uploadStates[key] === 'error' ? (
                        <AlertCircle className="w-3.5 h-3.5 text-red-600" />
                      ) : (
                        <Upload className="w-3.5 h-3.5 text-gray-500" />
                      )}
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                        {uploadStates[key] === 'uploading' ? 'Subiendo...' :
                         uploadStates[key] === 'success' ? (uploadMessages[key] || 'Subido') :
                         uploadStates[key] === 'error' ? (uploadMessages[key] || 'Error al subir') :
                         'Subir .pt o .onnx'}
                      </span>
                      <input
                        type="file"
                        accept=".pt,.onnx"
                        className="hidden"
                        disabled={uploadStates[key] === 'uploading'}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setUploadStates(s => ({ ...s, [key]: 'uploading' }));
                          setUploadMessages(s => ({ ...s, [key]: '' }));
                          try {
                            const formData = new FormData();
                            formData.append('file', file);
                            const response = await fetch(`${API_BASE_URL}/api/flow/upload`, {
                              method: 'POST',
                              body: formData,
                            });
                            if (response.ok) {
                              const result = await response.json();
                              handleConfigChange(key, result.file_path);
                              setUploadStates(s => ({ ...s, [key]: 'success' }));
                              setUploadMessages(s => ({ ...s, [key]: result.filename }));
                            } else {
                              const err = await response.text();
                              setUploadStates(s => ({ ...s, [key]: 'error' }));
                              setUploadMessages(s => ({ ...s, [key]: err.slice(0, 60) }));
                            }
                          } catch (err) {
                            setUploadStates(s => ({ ...s, [key]: 'error' }));
                            setUploadMessages(s => ({ ...s, [key]: String(err).slice(0, 60) }));
                          }
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                ) : String(value).includes('\n') ? (
                  <textarea
                    value={String(value)}
                    onChange={e => handleConfigChange(key, e.target.value)}
                    rows={5}
                    className="ui-input text-xs font-mono resize-none"
                  />
                ) : Array.isArray(value) || typeof value === 'object' ? (
                  <textarea
                    value={JSON.stringify(value, null, 2)}
                    onChange={e => {
                      try {
                        handleConfigChange(key, JSON.parse(e.target.value));
                      } catch { /* ignore */ }
                    }}
                    rows={3}
                    className="ui-input text-xs font-mono resize-none"
                  />
                ) : (
                  <input
                    type="text"
                    value={String(value)}
                    onChange={e => handleConfigChange(key, e.target.value)}
                    className="ui-input text-xs"
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Node ID */}
        <div className="px-4 py-3 border-t border-gray-200 dark:border-slate-800">
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <Info className="w-3 h-3 shrink-0" />
            <span className="font-mono break-all">{node.id}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

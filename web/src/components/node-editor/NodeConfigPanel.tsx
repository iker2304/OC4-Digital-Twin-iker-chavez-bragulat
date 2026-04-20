import { X, Info, Upload, CheckCircle, AlertCircle, Loader, Camera, RefreshCw } from 'lucide-react';
import { useNodeEditorStore, CATEGORY_META } from '../../store/nodeEditorStore';
import { useState } from 'react';
import type { Node } from '@xyflow/react';

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
    inputs: { id: string; label: string; dataType: string }[];
    outputs: { id: string; label: string; dataType: string }[];
    config: Record<string, unknown>;
  };

  const color = data.color || '#6366f1';
  const category = data.category as keyof typeof CATEGORY_META;
  const catMeta = CATEGORY_META[category];

  const handleConfigChange = (key: string, value: unknown) => {
    updateNodeConfig(node.id, { [key]: value });
  };

  return (
    <div className="w-72 bg-white dark:bg-slate-800 border-l border-gray-200 dark:border-slate-700 flex flex-col h-full shrink-0">
      {/* Header */}
      <div
        className="px-4 py-3 border-b border-gray-100 dark:border-slate-700 flex items-center justify-between"
        style={{ background: `${color}08` }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-base"
            style={{ background: `${color}15`, border: `1px solid ${color}30` }}
          >
            {data.icon}
          </div>
          <div>
            <h3 className="text-sm font-bold" style={{ color }}>{data.label}</h3>
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
              style={{ background: `${color}15`, color }}
            >
              {catMeta?.icon} {catMeta?.label}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 transition-all"
        >
          <X className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {/* Ports section */}
        <div className="px-4 py-3 border-b border-gray-100 dark:border-slate-700">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Ports</p>
          <div className="space-y-1">
            {data.inputs.map(p => (
              <div key={p.id} className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: DATA_TYPE_COLORS[p.dataType] || '#94a3b8' }}
                />
                <span className="text-[11px] text-gray-600 dark:text-gray-400">{p.label}</span>
                <span
                  className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full font-mono"
                  style={{
                    background: `${DATA_TYPE_COLORS[p.dataType] || '#94a3b8'}15`,
                    color: DATA_TYPE_COLORS[p.dataType] || '#94a3b8',
                  }}
                >
                  in · {p.dataType}
                </span>
              </div>
            ))}
            {data.outputs.map(p => (
              <div key={p.id} className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: DATA_TYPE_COLORS[p.dataType] || '#94a3b8' }}
                />
                <span className="text-[11px] text-gray-600 dark:text-gray-400">{p.label}</span>
                <span
                  className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full font-mono"
                  style={{
                    background: `${DATA_TYPE_COLORS[p.dataType] || '#94a3b8'}15`,
                    color: DATA_TYPE_COLORS[p.dataType] || '#94a3b8',
                  }}
                >
                  out · {p.dataType}
                </span>
              </div>
            ))}
            {data.inputs.length === 0 && data.outputs.length === 0 && (
              <p className="text-[11px] text-gray-400 italic">No ports defined</p>
            )}
          </div>
        </div>

        {/* Config section */}
        <div className="px-4 py-3">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Configuration</p>
          <div className="space-y-3">
            {Object.entries(data.config).map(([key, value]) => (
              <div key={key}>
                <label className="block text-[11px] font-semibold text-gray-500 dark:text-gray-400 mb-1 capitalize">
                  {key.replace(/_/g, ' ')}
                </label>
                {key === 'cameraIndex' ? (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={0}
                        value={Number(value)}
                        onChange={e => handleConfigChange(key, parseInt(e.target.value) || 0)}
                        className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500/30 transition-all"
                      />
                      <button
                        onClick={async () => {
                          setCamerasLoading(true);
                          try {
                            const res = await fetch('http://localhost:8080/api/flow/cameras');
                            if (res.ok) {
                              const d = await res.json();
                              setCameras(d.cameras || []);
                            }
                          } catch { /* ignore */ } finally {
                            setCamerasLoading(false);
                          }
                        }}
                        className="px-2 py-2 rounded-xl bg-purple-50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/30 hover:bg-purple-100 transition-all shrink-0"
                        title="Detect cameras"
                      >
                        {camerasLoading
                          ? <Loader className="w-3.5 h-3.5 text-purple-500 animate-spin" />
                          : <RefreshCw className="w-3.5 h-3.5 text-purple-500" />}
                      </button>
                    </div>
                    {cameras.length > 0 && (
                      <div className="space-y-1">
                        {cameras.map(cam => (
                          <button
                            key={cam.index}
                            onClick={() => handleConfigChange(key, cam.index)}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-left transition-all border ${
                              Number(value) === cam.index
                                ? 'bg-purple-50 dark:bg-purple-500/20 border-purple-300 dark:border-purple-500/50'
                                : 'bg-gray-50 dark:bg-slate-900/50 border-gray-200 dark:border-slate-600 hover:border-purple-300'
                            }`}
                          >
                            <Camera className="w-3 h-3 text-purple-500 shrink-0" />
                            <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">Camera {cam.index}</span>
                            <span className="ml-auto text-[9px] text-gray-400 font-mono">{cam.resolution} · {cam.fps.toFixed(0)}fps</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {cameras.length === 0 && !camerasLoading && (
                      <p className="text-[10px] text-gray-400 italic">Click refresh to detect cameras</p>
                    )}
                  </div>
                ) : typeof value === 'boolean' ? (
                  <button
                    onClick={() => handleConfigChange(key, !value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      value
                        ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400'
                        : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-gray-400'
                    }`}
                  >
                    {value ? '✓ Enabled' : '○ Disabled'}
                  </button>
                ) : typeof value === 'number' ? (
                  <input
                    type="number"
                    value={value}
                    onChange={e => handleConfigChange(key, parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all"
                  />
                ) : key === 'uploadedFile' || key === 'modelFile' ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={String(value)}
                      onChange={e => handleConfigChange(key, e.target.value)}
                      className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all"
                      placeholder="e.g. uploads/model.onnx"
                    />
                    <label className={`flex items-center justify-center gap-2 px-3 py-2 border-2 border-dashed rounded-xl cursor-pointer transition-all group ${
                      uploadStates[key] === 'success'
                        ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-500/10'
                        : uploadStates[key] === 'error'
                        ? 'border-red-400 bg-red-50 dark:bg-red-500/10'
                        : uploadStates[key] === 'uploading'
                        ? 'border-blue-300 bg-blue-50 dark:bg-blue-500/10 cursor-wait'
                        : 'border-gray-200 dark:border-slate-700 hover:bg-blue-50 dark:hover:bg-blue-500/10 hover:border-blue-300'
                    }`}>
                      {uploadStates[key] === 'uploading' ? (
                        <Loader className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                      ) : uploadStates[key] === 'success' ? (
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                      ) : uploadStates[key] === 'error' ? (
                        <AlertCircle className="w-3.5 h-3.5 text-red-500" />
                      ) : (
                        <Upload className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-500" />
                      )}
                      <span className={`text-[10px] font-bold uppercase ${
                        uploadStates[key] === 'success' ? 'text-emerald-600' :
                        uploadStates[key] === 'error' ? 'text-red-600' :
                        uploadStates[key] === 'uploading' ? 'text-blue-600' :
                        'text-gray-500 group-hover:text-blue-600'
                      }`}>
                        {uploadStates[key] === 'uploading' ? 'Uploading…' :
                         uploadStates[key] === 'success' ? (uploadMessages[key] || 'Uploaded') :
                         uploadStates[key] === 'error' ? (uploadMessages[key] || 'Upload failed') :
                         'Upload .pt or .onnx'}
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
                            const response = await fetch('http://localhost:8080/api/flow/upload', {
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
                    className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all resize-none"
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
                    className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all resize-none"
                  />
                ) : (
                  <input
                    type="text"
                    value={String(value)}
                    onChange={e => handleConfigChange(key, e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all"
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Node ID */}
        <div className="px-4 py-3 border-t border-gray-100 dark:border-slate-700">
          <div className="flex items-center gap-1.5 text-[9px] text-gray-400">
            <Info className="w-3 h-3" />
            <span className="font-mono break-all">{node.id}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

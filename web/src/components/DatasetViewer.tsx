import { useState, useEffect, useMemo } from 'react';
import { API_BASE_URL } from '../config/api';
import {
  Database, Upload, Trash2, Save, Sparkles, Split, Eye, EyeOff, RefreshCw, X, Loader2,
} from 'lucide-react';
import { Button } from './ui';

type DatasetStats = {
  dataset: string;
  train_count: number;
  val_count: number;
  raw_count?: number;
  total_count: number;
};

interface ParsedYoloObject {
  classId: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  keypoints: { x: number; y: number; v: number }[];
}

function parseYoloPoseContent(text: string): ParsedYoloObject[] {
  if (!text || !text.trim()) return [];
  const lines = text.trim().split('\n');
  const objects: ParsedYoloObject[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/).map(Number);
    if (parts.length >= 5 && !parts.some(isNaN)) {
      const [classId, cx, cy, w, h, ...rest] = parts;
      const keypoints: { x: number; y: number; v: number }[] = [];
      for (let i = 0; i + 1 < rest.length; i += 3) {
        keypoints.push({
          x: rest[i],
          y: rest[i + 1],
          v: rest[i + 2] ?? 2,
        });
      }
      objects.push({ classId, cx, cy, w, h, keypoints });
    }
  }
  return objects;
}

export default function DatasetViewer({
  onClose,
  initialDataset = '',
}: {
  onClose: () => void;
  initialDataset?: string;
}) {
  const [datasets, setDatasets] = useState<{ name: string; totalImages: number }[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<string>(initialDataset);
  const [subset, setSubset] = useState<'train' | 'val'>('train');
  const [images, setImages] = useState<string[]>([]);
  const [stats, setStats] = useState<DatasetStats | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [labelContent, setLabelContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const queryParam = selectedDataset ? `?dataset=${encodeURIComponent(selectedDataset)}` : '';

  const loadDatasetList = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/dataset/list`);
      if (res.ok) {
        const data = await res.json();
        setDatasets(data.datasets || []);
        if (!selectedDataset && data.datasets?.length > 0) {
          setSelectedDataset(data.datasets[0].name);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const loadStatsAndImages = async () => {
    setLoading(true);
    try {
      const [statsRes, imgRes] = await Promise.all([
        fetch(`${API_BASE_URL}/dataset/stats${queryParam}`),
        fetch(`${API_BASE_URL}/dataset/images/${subset}${queryParam}`),
      ]);
      if (statsRes.ok) {
        setStats(await statsRes.json());
      }
      if (imgRes.ok) {
        const list = await imgRes.json();
        setImages(Array.isArray(list) ? list : []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDatasetList();
  }, []);

  useEffect(() => {
    loadStatsAndImages();
  }, [subset, selectedDataset]);

  useEffect(() => {
    if (selectedImage) {
      fetch(`${API_BASE_URL}/dataset/file/${subset}/labels/${selectedImage}${queryParam}`)
        .then((res) => res.json())
        .then((data) => setLabelContent(data.content || ''))
        .catch(console.error);
    } else {
      setLabelContent('');
    }
  }, [selectedImage, subset, selectedDataset]);

  const parsedObjects = useMemo(() => parseYoloPoseContent(labelContent), [labelContent]);

  const handleSaveLabel = async () => {
    if (!selectedImage) return;
    try {
      const res = await fetch(
        `${API_BASE_URL}/dataset/file/${subset}/labels/${selectedImage}${queryParam}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: labelContent }),
        }
      );
      if (res.ok) {
        setSaveMessage('Etiqueta guardada correctamente');
        setTimeout(() => setSaveMessage(null), 2500);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteSample = async () => {
    if (!selectedImage) return;
    try {
      const res = await fetch(
        `${API_BASE_URL}/dataset/file/${subset}/${selectedImage}${queryParam}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        setSelectedImage(null);
        loadStatsAndImages();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleGenerateSamples = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/dataset/generate-samples`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset: selectedDataset || 'Floating platform.v1i.yolov11',
          numTrain: 12,
          numVal: 4,
          keypointsCount: 11,
        }),
      });
      if (res.ok) {
        loadStatsAndImages();
        loadDatasetList();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSplitDataset = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/dataset/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset: selectedDataset || 'Floating platform.v1i.yolov11',
          trainRatio: 0.8,
        }),
      });
      if (res.ok) {
        loadStatsAndImages();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetch(`${API_BASE_URL}/dataset/upload/${subset}${queryParam}`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        loadStatsAndImages();
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-lg shadow-xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden text-gray-900 dark:text-gray-100">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-800 flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-semibold">Explorador y editor de datasets YOLO Pose</h2>
            <select
              value={selectedDataset}
              onChange={(e) => {
                setSelectedDataset(e.target.value);
                setSelectedImage(null);
              }}
              className="ui-input text-xs py-1 w-auto"
            >
              {datasets.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} ({d.totalImages} imgs)
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <Button variant="secondary" size="sm" onClick={handleGenerateSamples}>
              <Sparkles className="w-3.5 h-3.5" /> Generar muestras
            </Button>

            <Button variant="secondary" size="sm" onClick={handleSplitDataset}>
              <Split className="w-3.5 h-3.5" /> Split 80/20
            </Button>

            <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700 text-xs font-medium cursor-pointer transition-colors">
              <Upload className="w-3.5 h-3.5" /> Subir imagen
              <input type="file" accept=".png,.jpg,.jpeg" className="hidden" onChange={handleUploadFile} />
            </label>

            <div className="text-xs font-mono text-gray-500 bg-gray-50 dark:bg-slate-800 px-2.5 py-1 rounded-md border border-gray-200 dark:border-slate-700">
              Total: <b>{stats?.total_count || 0}</b> (T: {stats?.train_count || 0} · V: {stats?.val_count || 0})
            </div>

            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Grid */}
          <div className={`flex-1 flex flex-col ${selectedImage ? 'w-3/5' : 'w-full'}`}>
            <div className="px-4 py-2.5 flex items-center justify-between border-b border-gray-200 dark:border-slate-800 bg-gray-50/60 dark:bg-slate-900/60">
              <div className="flex gap-1.5">
                <button
                  onClick={() => {
                    setSubset('train');
                    setSelectedImage(null);
                  }}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    subset === 'train'
                      ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800'
                  }`}
                >
                  Train ({stats?.train_count || 0})
                </button>
                <button
                  onClick={() => {
                    setSubset('val');
                    setSelectedImage(null);
                  }}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    subset === 'val'
                      ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800'
                  }`}
                >
                  Validation ({stats?.val_count || 0})
                </button>
              </div>

              <Button variant="ghost" size="sm" onClick={loadStatsAndImages} title="Refrescar lista">
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-gray-50/40 dark:bg-slate-950/40">
              {loading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {images.map((img) => (
                    <div
                      key={img}
                      onClick={() => setSelectedImage(img)}
                      className={`group cursor-pointer border rounded-lg overflow-hidden transition-all bg-white dark:bg-slate-900 ${
                        selectedImage === img
                          ? 'border-blue-600 ring-2 ring-blue-500/20'
                          : 'border-gray-200 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="aspect-square bg-gray-950 relative">
                        <img
                          src={`${API_BASE_URL}/dataset/file/${subset}/images/${img}${queryParam}`}
                          alt={img}
                          className="object-cover w-full h-full"
                          loading="lazy"
                        />
                      </div>
                      <div className="p-1.5 text-[11px] truncate text-center text-gray-600 dark:text-gray-300 font-mono">
                        {img}
                      </div>
                    </div>
                  ))}
                  {images.length === 0 && (
                    <div className="col-span-full text-center py-12 text-gray-500 space-y-3">
                      <p className="text-xs">No se encontraron imágenes en la partición "{subset}".</p>
                      <Button variant="primary" size="sm" onClick={handleGenerateSamples}>
                        Generar muestras sintéticas ahora
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right Detail & Annotation Overlay View */}
          {selectedImage && (
            <div className="w-[440px] border-l border-gray-200 dark:border-slate-800 flex flex-col bg-white dark:bg-slate-900 z-20">
              <div className="p-3 border-b border-gray-200 dark:border-slate-800 flex justify-between items-center">
                <h3 className="font-semibold truncate text-xs font-mono text-gray-900 dark:text-white" title={selectedImage}>
                  {selectedImage}
                </h3>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant={showOverlay ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => setShowOverlay(!showOverlay)}
                  >
                    {showOverlay ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    Keypoints
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDeleteSample}
                    className="hover:text-red-600"
                    title="Eliminar muestra"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-slate-800 bg-gray-950 relative flex items-center justify-center">
                  <div className="relative w-full aspect-square max-h-[340px]">
                    <img
                      src={`${API_BASE_URL}/dataset/file/${subset}/images/${selectedImage}${queryParam}`}
                      alt={selectedImage}
                      className="w-full h-full object-contain"
                    />
                    {showOverlay && parsedObjects.length > 0 && (
                      <svg
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        className="absolute inset-0 w-full h-full pointer-events-none"
                      >
                        {parsedObjects.map((obj, idx) => {
                          const x = (obj.cx - obj.w / 2) * 100;
                          const y = (obj.cy - obj.h / 2) * 100;
                          const w = obj.w * 100;
                          const h = obj.h * 100;
                          return (
                            <g key={idx}>
                              <rect
                                x={x}
                                y={y}
                                width={w}
                                height={h}
                                fill="rgba(59, 130, 246, 0.08)"
                                stroke="#3b82f6"
                                strokeWidth="0.6"
                                strokeDasharray="1.5,1"
                              />
                              {obj.keypoints.map((kp, kIdx) =>
                                kp.v > 0 ? (
                                  <g key={kIdx}>
                                    <circle
                                      cx={kp.x * 100}
                                      cy={kp.y * 100}
                                      r="1.3"
                                      fill="#10b981"
                                      stroke="#022c22"
                                      strokeWidth="0.3"
                                    />
                                    <text
                                      x={kp.x * 100 + 1.6}
                                      y={kp.y * 100 - 1.0}
                                      fill="#f8fafc"
                                      fontSize="2.8"
                                      fontWeight="bold"
                                    >
                                      K{kIdx + 1}
                                    </text>
                                  </g>
                                ) : null
                              )}
                            </g>
                          );
                        })}
                      </svg>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="ui-eyebrow">
                      Anotación YOLO Pose (.txt) — {parsedObjects[0]?.keypoints.length || 0} Keypoints
                    </h4>
                    <Button variant="primary" size="sm" onClick={handleSaveLabel}>
                      <Save className="w-3.5 h-3.5" /> Guardar
                    </Button>
                  </div>

                  {saveMessage && (
                    <div className="text-xs text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 px-2.5 py-1 rounded">
                      {saveMessage}
                    </div>
                  )}

                  <textarea
                    value={labelContent}
                    onChange={(e) => setLabelContent(e.target.value)}
                    rows={6}
                    className="ui-input text-xs font-mono"
                    placeholder="class cx cy w h kp1_x kp1_y kp1_v ..."
                  />
                </div>

                <div className="text-[11px] text-gray-400 space-y-1 font-mono">
                  <p>Dataset: {stats?.dataset || selectedDataset}</p>
                  <p>Imagen: /{subset}/images/{selectedImage}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

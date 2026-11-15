import { useState, useEffect, useMemo } from 'react';
import { API_BASE_URL } from '../config/api';
import {
  Database, Upload, Trash2, Save, Sparkles, Split, Eye, EyeOff, RefreshCw, X
} from 'lucide-react';

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
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex flex-wrap justify-between items-center gap-3 bg-slate-950">
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-bold text-white">Explorador y Editor de Datasets YOLO Pose</h2>
            <select
              value={selectedDataset}
              onChange={(e) => {
                setSelectedDataset(e.target.value);
                setSelectedImage(null);
              }}
              className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
            >
              {datasets.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} ({d.totalImages} imgs)
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={handleGenerateSamples}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 text-xs font-medium"
              title="Generar muestras sintéticas anotadas con 11 keypoints"
            >
              <Sparkles className="w-3.5 h-3.5" /> + Generar Muestras Pose
            </button>

            <button
              onClick={handleSplitDataset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 text-xs font-medium"
              title="Dividir imágenes en Train (80%) y Val (20%)"
            >
              <Split className="w-3.5 h-3.5" /> Split Train/Val (80/20)
            </button>

            <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-medium cursor-pointer">
              <Upload className="w-3.5 h-3.5" /> Subir Imagen
              <input type="file" accept=".png,.jpg,.jpeg" className="hidden" onChange={handleUploadFile} />
            </label>

            <div className="text-xs text-slate-300 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800">
              Total: <b>{stats?.total_count || 0}</b> (Train: {stats?.train_count || 0} | Val: {stats?.val_count || 0})
            </div>

            <button
              onClick={onClose}
              className="text-slate-400 hover:text-red-400 transition-colors p-1.5 rounded-lg hover:bg-slate-800"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Grid */}
          <div className={`flex-1 flex flex-col transition-all duration-300 ${selectedImage ? 'w-3/5' : 'w-full'}`}>
            <div className="p-3 flex items-center justify-between border-b border-slate-800 bg-slate-900/60">
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setSubset('train');
                    setSelectedImage(null);
                  }}
                  className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    subset === 'train'
                      ? 'bg-blue-600 text-white shadow'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Train ({stats?.train_count || 0})
                </button>
                <button
                  onClick={() => {
                    setSubset('val');
                    setSelectedImage(null);
                  }}
                  className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    subset === 'val'
                      ? 'bg-blue-600 text-white shadow'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Validation ({stats?.val_count || 0})
                </button>
              </div>

              <button
                onClick={loadStatsAndImages}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                title="Refrescar lista"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-slate-950/50">
              {loading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500"></div>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {images.map((img) => (
                    <div
                      key={img}
                      onClick={() => setSelectedImage(img)}
                      className={`group cursor-pointer border-2 rounded-lg overflow-hidden transition-all ${
                        selectedImage === img
                          ? 'border-blue-500 ring-2 ring-blue-500/40 scale-[1.02]'
                          : 'border-slate-800 hover:border-slate-600'
                      }`}
                    >
                      <div className="aspect-square bg-slate-900 relative">
                        <img
                          src={`${API_BASE_URL}/dataset/file/${subset}/images/${img}${queryParam}`}
                          alt={img}
                          className="object-cover w-full h-full"
                          loading="lazy"
                        />
                      </div>
                      <div className="p-1.5 text-[11px] truncate text-center bg-slate-900 text-slate-300 font-mono">
                        {img}
                      </div>
                    </div>
                  ))}
                  {images.length === 0 && (
                    <div className="col-span-full text-center py-12 text-slate-500 space-y-3">
                      <p>No se encontraron imágenes en la partición "{subset}".</p>
                      <button
                        onClick={handleGenerateSamples}
                        className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold"
                      >
                        Generar Muestras Sintéticas Ahora
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right Detail & Annotation Overlay View */}
          {selectedImage && (
            <div className="w-[460px] border-l border-slate-800 flex flex-col bg-slate-900 shadow-2xl z-20">
              <div className="p-3 border-b border-slate-800 flex justify-between items-center bg-slate-950">
                <h3 className="font-bold truncate text-xs font-mono text-blue-300" title={selectedImage}>
                  {selectedImage}
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowOverlay(!showOverlay)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs ${
                      showOverlay ? 'bg-blue-600/30 text-blue-300' : 'bg-slate-800 text-slate-400'
                    }`}
                    title="Mostrar/ocultar Bounding Box y Keypoints"
                  >
                    {showOverlay ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    Keypoints
                  </button>
                  <button
                    onClick={handleDeleteSample}
                    className="p-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400"
                    title="Eliminar muestra"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* Image with SVG BBox + Keypoints Overlay */}
                <div className="rounded-lg overflow-hidden border border-slate-700 bg-slate-950 relative flex items-center justify-center">
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

                {/* Editable YOLO Label Content */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="font-semibold text-xs uppercase text-slate-400 tracking-wider">
                      Anotación YOLO Pose (.txt) — {parsedObjects[0]?.keypoints.length || 0} Keypoints
                    </h4>
                    <button
                      onClick={handleSaveLabel}
                      className="flex items-center gap-1 px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
                    >
                      <Save className="w-3.5 h-3.5" /> Guardar Etiqueta
                    </button>
                  </div>

                  {saveMessage && (
                    <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded">
                      {saveMessage}
                    </div>
                  )}

                  <textarea
                    value={labelContent}
                    onChange={(e) => setLabelContent(e.target.value)}
                    rows={6}
                    className="w-full bg-slate-950 p-3 rounded-lg border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500"
                    placeholder="class cx cy w h kp1_x kp1_y kp1_v ..."
                  />
                </div>

                <div className="text-[11px] text-slate-500 space-y-1 font-mono">
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

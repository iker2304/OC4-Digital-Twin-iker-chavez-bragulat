// @ts-nocheck - react-grid-layout types can be inconsistent across versions
import { useEffect, useMemo, useRef, useState } from 'react';
import { ModelViewer } from '../components/3d/ModelViewer';
import { DetectionSettings } from '../components/dashboard/DetectionSettings';
import { RealTimeChart } from '../components/dashboard/RealTimeChart';
import { DetectedObjectsPanel } from '../components/dashboard/DetectedObjectsPanel';
import { useTwinStore } from '../store/twinStore';
import { Maximize2, Video, Activity, Ruler, RotateCw, Move, Edit3, Save, RotateCcw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const MJPEG_URL = 'http://127.0.0.1:8001/video_feed';
const LAYOUT_STORAGE_KEY = 'oc4_twin_layout_v1';
const DEFAULT_LAYOUT = [
  { i: 'viewer', x: 0, y: 0, w: 7, h: 6, minW: 4, minH: 4 },
  { i: 'orientation', x: 0, y: 6, w: 7, h: 5, minW: 4, minH: 4 },
  { i: 'position', x: 0, y: 11, w: 7, h: 5, minW: 4, minH: 4 },
  { i: 'video', x: 7, y: 0, w: 5, h: 6, minW: 4, minH: 4 },
  { i: 'metrics', x: 7, y: 6, w: 5, h: 3, minW: 3, minH: 2 },
  { i: 'objects', x: 7, y: 9, w: 5, h: 4, minW: 3, minH: 3 },
  { i: 'settings', x: 7, y: 13, w: 5, h: 3, minW: 3, minH: 2 },
];

const MetricCard = ({ label, value, icon: Icon, color }: { label: string, value: string, icon: LucideIcon, color: string }) => (
  <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm flex items-center justify-between">
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wider">{label}</p>
      <p className="text-xl font-bold text-gray-900 dark:text-white mt-1 font-mono">{value}</p>
    </div>
    <div className={`p-3 rounded-lg ${color.replace('text-', 'bg-').replace('500', '100')} dark:bg-opacity-20`}>
      <Icon className={`w-5 h-5 ${color}`} />
    </div>
  </div>
);

export default function Twin() {
  const { connect, navigation } = useTwinStore();
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [gridWidth, setGridWidth] = useState(1200);
  const [layout, setLayout] = useState(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].i) {
          return parsed;
        }
      }
      return DEFAULT_LAYOUT;
    } catch {
      return DEFAULT_LAYOUT;
    }
  });

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    const element = gridContainerRef.current;
    if (!element) return;

    const updateWidth = () => {
      setGridWidth(Math.max(1, element.clientWidth));
    };

    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const saveLayout = () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    setIsEditing(false);
  };

  const resetLayout = () => {
    setLayout(DEFAULT_LAYOUT);
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(DEFAULT_LAYOUT));
  };

  const safePitch = Number(navigation?.pitch) || 0;
  const pitchValue = safePitch.toFixed(2);
  
  const posX = Number(navigation?.position?.x) || 0;
  const posY = Number(navigation?.position?.y) || 0;
  const posZ = Number(navigation?.position?.z) || 0;
  
  const distanceFromPosition = Math.sqrt(
    posX ** 2 + posY ** 2 + posZ ** 2
  ).toFixed(2);

  const panelBaseClass = useMemo(
    () =>
      `rounded-xl ${isEditing ? 'ring-2 ring-dashed ring-blue-400/70' : ''}`,
    [isEditing]
  );

  return (
    <div className="w-full min-w-0 p-4 h-full overflow-y-auto bg-gray-50 dark:bg-slate-950">
      <div className="flex items-center justify-between mb-4 sticky top-0 z-50 bg-gray-50/80 dark:bg-slate-950/80 backdrop-blur-sm py-2">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Twin Monitor</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={resetLayout}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800"
            title="Restaurar layout por defecto"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          {isEditing ? (
            <button
              onClick={saveLayout}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-500"
              title="Guardar layout personalizado"
            >
              <Save className="w-3.5 h-3.5" />
              Guardar
            </button>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-500"
              title="Editar y redimensionar paneles"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Editar layout
            </button>
          )}
        </div>
      </div>

      <div ref={gridContainerRef} className="w-full min-w-0">
        <GridLayout
          className="layout"
          layout={layout}
          cols={12}
          rowHeight={56}
          width={gridWidth}
          isDraggable={isEditing}
          isResizable={isEditing}
          onLayoutChange={setLayout}
          margin={[16, 16]}
          containerPadding={[0, 0]}
        >
          <div key="viewer" className={panelBaseClass}>
          <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-xl overflow-hidden relative h-full min-h-[280px]">
            <div className="absolute top-4 left-4 z-10 flex gap-2">
              <div className="bg-black/60 text-white px-3 py-1.5 rounded-lg text-xs backdrop-blur-md font-medium border border-white/10 flex items-center gap-2">
                <Activity className="w-3 h-3 text-blue-400" />
                3D Digital Twin
              </div>
              <div className="bg-black/60 text-white px-3 py-1.5 rounded-lg text-xs backdrop-blur-md font-medium border border-white/10 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                Online
              </div>
            </div>
            <ModelViewer editMode={isEditing} />
          </div>
        </div>

        <div key="orientation" className={panelBaseClass}>
          <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm flex flex-col h-full min-h-[220px]">
            <h3 className="text-sm font-semibold mb-4 text-gray-700 dark:text-gray-300 flex items-center gap-2">
              <RotateCw className="w-4 h-4 text-purple-500" />
              Orientation (Euler Angles)
            </h3>
            <div className="grid grid-cols-1 gap-2 flex-1 overflow-hidden">
              <RealTimeChart metric="roll" />
              <RealTimeChart metric="pitch" />
              <RealTimeChart metric="yaw" />
            </div>
          </div>
        </div>

        <div key="position" className={panelBaseClass}>
          <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm flex flex-col h-full min-h-[220px]">
            <h3 className="text-sm font-semibold mb-4 text-gray-700 dark:text-gray-300 flex items-center gap-2">
              <Move className="w-4 h-4 text-emerald-500" />
              Position (Displacement)
            </h3>
            <div className="grid grid-cols-1 gap-2 flex-1 overflow-hidden">
              <RealTimeChart metric="x" />
              <RealTimeChart metric="y" />
              <RealTimeChart metric="z" />
            </div>
          </div>
        </div>

        <div key="video" className={panelBaseClass}>
          <div className="bg-black rounded-xl border border-gray-800 shadow-lg overflow-hidden group relative h-full min-h-[260px]">
            <div className="absolute top-0 left-0 right-0 p-3 bg-gradient-to-b from-black/80 to-transparent z-10 flex justify-between items-center opacity-0 group-hover:opacity-100 transition-opacity">
              <h2 className="font-semibold flex items-center gap-2 text-white text-xs">
                <Video className="w-3 h-3 text-red-500" /> Live Feed
              </h2>
              <button onClick={() => window.open(MJPEG_URL, '_blank')} className="text-white/80 hover:text-white bg-white/10 p-1.5 rounded-lg backdrop-blur-sm transition-colors">
                <Maximize2 className="w-3 h-3" />
              </button>
            </div>
            <div className="w-full h-full flex items-center justify-center bg-slate-900">
              <img
                src={MJPEG_URL}
                alt="Live Stream"
                className="w-full h-full object-contain"
                loading="eager"
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  target.style.display = 'none';
                }}
              />
              <div className="absolute bottom-2 right-2 flex gap-1">
                <span className="px-1.5 py-0.5 bg-red-600 text-white text-[10px] font-bold rounded uppercase">Live</span>
                <span className="px-1.5 py-0.5 bg-gray-800 text-gray-300 text-[10px] font-mono rounded">MJPEG</span>
              </div>
            </div>
          </div>
        </div>

        <div key="metrics" className={panelBaseClass}>
          <div className="grid grid-cols-2 gap-4 h-full min-h-[130px]">
            <MetricCard
              label="Pitch Angle"
              value={pitchValue}
              icon={RotateCw}
              color="text-blue-500"
            />
            <MetricCard
              label="Distance (XYZ)"
              value={`${distanceFromPosition} m`}
              icon={Ruler}
              color="text-emerald-500"
            />
          </div>
        </div>

        <div key="objects" className={panelBaseClass}>
          <div className="h-full min-h-[180px]">
            <DetectedObjectsPanel />
          </div>
        </div>

          <div key="settings" className={panelBaseClass}>
            <div className="h-full min-h-[130px]">
              <DetectionSettings />
            </div>
          </div>
        </GridLayout>
      </div>
    </div>
  );
}

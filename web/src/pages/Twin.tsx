// @ts-nocheck - react-grid-layout types can be inconsistent across versions
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ModelViewer } from '../components/3d/ModelViewer';
import { DetectionSettings } from '../components/dashboard/DetectionSettings';
import { RealTimeChart } from '../components/dashboard/RealTimeChart';
import { DetectedObjectsPanel } from '../components/dashboard/DetectedObjectsPanel';
import { CameraHoverPicker } from '../components/dashboard/CameraHoverPicker';
import { useTwinStore } from '../store/twinStore';
import { Maximize2, Video, Ruler, RotateCw, Move, Edit3, Save, RotateCcw, WifiOff, Loader } from 'lucide-react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Button, Card, PageHeader, Stat } from '../components/ui';

const MJPEG_BASE = 'http://127.0.0.1:8001/video_feed';
const MJPEG_REFRESH_MS = 300000;
const MJPEG_STALL_TIMEOUT_MS = 90000;
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

const buildMjpegUrl = (ts: number) => `${MJPEG_BASE}?_t=${ts}`;

export default function Twin() {
  const { connect, navigation, cameraSource, revertCameraSource } = useTwinStore();
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [videoHovered, setVideoHovered] = useState(false);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleVideoEnter = () => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    setVideoHovered(true);
  };
  const handleVideoLeave = () => {
    leaveTimerRef.current = setTimeout(() => setVideoHovered(false), 150);
  };

  const [streamTs, setStreamTs] = useState(() => Date.now());
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamError, setStreamError] = useState(false);

  const [mjpegUrl, setMjpegUrl] = useState(() => buildMjpegUrl(Date.now()));
  const lastFrameTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    setMjpegUrl(buildMjpegUrl(streamTs));
  }, [streamTs]);

  const prevCameraSource = useRef(cameraSource);
  useEffect(() => {
    if (cameraSource !== prevCameraSource.current) {
      prevCameraSource.current = cameraSource;
      setStreamLoading(true);
      setStreamError(false);
      setMjpegUrl('');

      let cancelled = false;
      const targetSource = typeof cameraSource === 'number' ? cameraSource : null;
      const maxWaitMs = 5000;
      const pollIntervalMs = 200;
      const startTime = Date.now();
      let failureFlagClearedThisCycle = false;

      const pollAndConnect = async () => {
        await new Promise(r => setTimeout(r, pollIntervalMs));

        while (!cancelled) {
          const elapsed = Date.now() - startTime;
          if (elapsed > maxWaitMs) break;

          if (targetSource !== null) {
            try {
              const res = await fetch(`${MJPEG_BASE.replace('/video_feed', '')}/current_source`);
              if (res.ok) {
                const data = (await res.json()) as { source: number; switch_failed?: boolean };
                if (!data.switch_failed) {
                  failureFlagClearedThisCycle = true;
                } else if (failureFlagClearedThisCycle) {
                  prevCameraSource.current = data.source;
                  revertCameraSource(data.source);
                  break;
                }
                if (data.source === targetSource) break;
              }
            } catch {
              // keep polling
            }
          } else {
            break;
          }

          await new Promise(r => setTimeout(r, pollIntervalMs));
        }

        if (!cancelled) {
          setMjpegUrl(buildMjpegUrl(Date.now()));
        }
      };

      pollAndConnect();

      const hideTimer = setTimeout(() => {
        setStreamLoading(l => (l ? false : l));
      }, 7000);

      return () => {
        cancelled = true;
        clearTimeout(hideTimer);
      };
    }
  }, [cameraSource, revertCameraSource]);

  const handleStreamLoad = useCallback(() => {
    setStreamLoading(false);
    setStreamError(false);
    lastFrameTimeRef.current = Date.now();
  }, []);

  const handleStreamError = useCallback(() => {
    setStreamLoading(false);
    setStreamError(true);
  }, []);

  useEffect(() => {
    const refreshTimer = window.setInterval(() => {
      if (!streamLoading) {
        setStreamTs(Date.now());
      }
    }, MJPEG_REFRESH_MS);
    return () => window.clearInterval(refreshTimer);
  }, [streamLoading]);

  useEffect(() => {
    const stallTimer = window.setInterval(() => {
      if (!streamLoading && mjpegUrl && Date.now() - lastFrameTimeRef.current > MJPEG_STALL_TIMEOUT_MS) {
        lastFrameTimeRef.current = Date.now();
        setStreamTs(Date.now());
      }
    }, 2000);
    return () => window.clearInterval(stallTimer);
  }, [streamLoading, mjpegUrl]);

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
    return () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    };
  }, []);

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
  const pitchValue = `${safePitch.toFixed(2)}°`;

  const posX = Number(navigation?.position?.x) || 0;
  const posY = Number(navigation?.position?.y) || 0;
  const posZ = Number(navigation?.position?.z) || 0;

  const distanceFromPosition = Math.sqrt(posX ** 2 + posY ** 2 + posZ ** 2).toFixed(2);

  const panelBaseClass = useMemo(
    () => `rounded-xl ${isEditing ? 'ring-1 ring-dashed ring-blue-500/60' : ''}`,
    [isEditing]
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Monitor en tiempo real"
        description="Modelo 3D sincronizado, flujo de cámara MJPEG y series temporales de orientación y desplazamiento."
        actions={
          <>
            <Button variant="secondary" size="sm" icon={RotateCcw} onClick={resetLayout} title="Restaurar disposición">
              Restablecer
            </Button>
            {isEditing ? (
              <Button variant="primary" size="sm" icon={Save} onClick={saveLayout}>
                Guardar disposición
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon={Edit3} onClick={() => setIsEditing(true)}>
                Editar paneles
              </Button>
            )}
          </>
        }
      />

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
            <div className="relative h-full min-h-[280px] overflow-hidden rounded-xl">
              <ModelViewer editMode={isEditing} />
            </div>
          </div>

          <div key="orientation" className={panelBaseClass}>
            <Card className="flex h-full min-h-[220px] flex-col p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                <RotateCw className="h-4 w-4 text-zinc-400" strokeWidth={1.75} />
                Orientación (ángulos de Euler)
              </div>
              <div className="grid flex-1 grid-cols-1 gap-2 overflow-hidden">
                <RealTimeChart metric="roll" />
                <RealTimeChart metric="pitch" />
                <RealTimeChart metric="yaw" />
              </div>
            </Card>
          </div>

          <div key="position" className={panelBaseClass}>
            <Card className="flex h-full min-h-[220px] flex-col p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                <Move className="h-4 w-4 text-zinc-400" strokeWidth={1.75} />
                Posición (desplazamiento)
              </div>
              <div className="grid flex-1 grid-cols-1 gap-2 overflow-hidden">
                <RealTimeChart metric="x" />
                <RealTimeChart metric="y" />
                <RealTimeChart metric="z" />
              </div>
            </Card>
          </div>

          <div key="video" className={panelBaseClass}>
            <div
              className="group relative h-full min-h-[260px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950"
              onMouseEnter={handleVideoEnter}
              onMouseLeave={handleVideoLeave}
            >
              {/* Top controls bar */}
              <div className=" absolute inset-x-0 top-0 z-20 flex items-center justify-between bg-zinc-950/80 px-3 py-2 opacity-0 transition-opacity group-hover:opacity-100">
                <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                  <Video className="h-3.5 w-3.5 text-zinc-400" />
                  <span>Cámara en vivo</span>
                  {typeof cameraSource === 'number' && (
                    <span className="font-mono text-[10px] text-zinc-400">cam {cameraSource}</span>
                  )}
                </div>
                <button
                  onClick={() => window.open(mjpegUrl, '_blank')}
                  className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
                  title="Abrir en pestaña nueva"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Video stream */}
              <div className="relative flex h-full w-full items-center justify-center bg-zinc-950">
                {streamLoading && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-zinc-950/90">
                    <Loader className="h-5 w-5 animate-spin text-zinc-400" />
                    <span className="text-xs text-zinc-400">
                      Cambiando a cámara {typeof cameraSource === 'number' ? cameraSource : '…'}
                    </span>
                  </div>
                )}

                {streamError && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-zinc-950 px-6 text-center">
                    <WifiOff className="h-5 w-5 text-zinc-500" />
                    <span className="text-xs font-medium text-zinc-300">Servidor MJPEG no disponible</span>
                    <span className="font-mono text-[11px] text-zinc-500">{MJPEG_BASE}</span>
                    <span className="max-w-xs text-[11px] leading-relaxed text-zinc-500">
                      Verifica que <code className="font-mono text-zinc-300">pose_detection.py</code> esté en ejecución en el puerto 8001.
                    </span>
                    <button
                      onClick={() => {
                        setStreamError(false);
                        setStreamLoading(true);
                        setStreamTs(Date.now());
                      }}
                      className="mt-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
                    >
                      Reintentar
                    </button>
                  </div>
                )}

                {mjpegUrl ? (
                  <img
                    key={mjpegUrl}
                    src={mjpegUrl}
                    alt="Live Stream"
                    className="h-full w-full object-contain"
                    loading="eager"
                    onLoad={handleStreamLoad}
                    onError={handleStreamError}
                  />
                ) : null}

                {!videoHovered && !streamLoading && !streamError && (
                  <div className="absolute bottom-2.5 right-2.5 z-10 flex gap-1">
                    <span className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900/90 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> EN VIVO
                    </span>
                    <span className="rounded border border-zinc-800 bg-zinc-900/90 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                      MJPEG
                    </span>
                  </div>
                )}
              </div>

              <CameraHoverPicker
                visible={videoHovered && !isEditing}
                onMouseEnter={handleVideoEnter}
                onMouseLeave={handleVideoLeave}
              />
            </div>
          </div>

          <div key="metrics" className={panelBaseClass}>
            <div className="grid h-full min-h-[110px] grid-cols-2 gap-4">
              <Stat label="Ángulo de cabeceo (pitch)" value={pitchValue} icon={RotateCw} className="flex flex-col justify-between" />
              <Stat label="Desplazamiento (XYZ)" value={`${distanceFromPosition} m`} icon={Ruler} className="flex flex-col justify-between" />
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

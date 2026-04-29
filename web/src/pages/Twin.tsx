// @ts-nocheck - react-grid-layout types can be inconsistent across versions
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ModelViewer } from '../components/3d/ModelViewer';
import { DetectionSettings } from '../components/dashboard/DetectionSettings';
import { RealTimeChart } from '../components/dashboard/RealTimeChart';
import { DetectedObjectsPanel } from '../components/dashboard/DetectedObjectsPanel';
import { CameraHoverPicker } from '../components/dashboard/CameraHoverPicker';
import { useTwinStore } from '../store/twinStore';
import { Maximize2, Video, Activity, Ruler, RotateCw, Move, Edit3, Save, RotateCcw, WifiOff, Loader } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const MJPEG_BASE = 'http://127.0.0.1:8001/video_feed';
const MJPEG_REFRESH_MS = 300000; // 5 min — periodic keep-alive reconnect
// Max ms without a new frame before we force-reconnect the MJPEG stream.
// MJPEG connections can freeze silently (no onerror) after ~2-3 min on macOS/Safari.
// NOTE: <img> onLoad fires only once (on connection open, not per-frame), so this
// timeout must be longer than the longest expected stream run without a reconnect.
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
    // Small delay so moving into picker child elements doesn't close it
    leaveTimerRef.current = setTimeout(() => setVideoHovered(false), 150);
  };

  // Build the MJPEG URL reactively so it updates when the user picks a camera.
  // We add a ?_t= cache-buster so the browser doesn't reuse the previous connection.
  const [streamTs, setStreamTs] = useState(() => Date.now());
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamError, setStreamError] = useState(false);

  const [mjpegUrl, setMjpegUrl] = useState(() => buildMjpegUrl(Date.now()));
  const lastFrameTimeRef = useRef<number>(Date.now());

  // Force a fresh MJPEG request when `streamTs` changes (retry/watchdog).
  useEffect(() => {
    setMjpegUrl(buildMjpegUrl(streamTs));
  }, [streamTs]);

  const prevCameraSource = useRef(cameraSource);
  useEffect(() => {
    if (cameraSource !== prevCameraSource.current) {
      prevCameraSource.current = cameraSource;
      setStreamLoading(true);
      setStreamError(false);

      // Temporarily clear the stream URL to force the browser to close the connection
      setMjpegUrl('');

      let cancelled = false;

      // Poll the MJPEG server until it confirms the source switch, then reconnect.
      // This avoids the race condition where we reconnect before the backend has
      // updated _current_source, causing the new stream to be immediately killed.
      const targetSource = typeof cameraSource === 'number' ? cameraSource : null;
      const maxWaitMs = 5000;
      const pollIntervalMs = 200;
      const startTime = Date.now();
      // `switch_failed` in backend is a global "last failure" flag.
      // It can remain true from a previous attempt, so we only trust it
      // after we first observe it cleared during this polling cycle.
      let failureFlagClearedThisCycle = false;

      const pollAndConnect = async () => {
        // Wait at minimum one poll cycle so the browser fully closes the old connection
        await new Promise(r => setTimeout(r, pollIntervalMs));

        while (!cancelled) {
          const elapsed = Date.now() - startTime;
          if (elapsed > maxWaitMs) break; // safety timeout — connect anyway

          if (targetSource !== null) {
            try {
              const res = await fetch(`${MJPEG_BASE.replace('/video_feed', '')}/current_source`);
              if (res.ok) {
                const data = await res.json() as { source: number; switch_failed?: boolean };
                if (!data.switch_failed) {
                  failureFlagClearedThisCycle = true;
                } else if (failureFlagClearedThisCycle) {
                  // Backend could not open the target camera and reverted.
                  // Sync the store back to the actual source so the UI reflects reality,
                  // without sending another POST to the backend (which would loop).
                  // Also update prevCameraSource so the useEffect doesn't re-fire.
                  prevCameraSource.current = data.source;
                  revertCameraSource(data.source);
                  break;
                }
                if (data.source === targetSource) break; // backend ready
              }
            } catch {
              // MJPEG server not reachable yet — keep polling
            }
          } else {
            break; // non-numeric source, just wait the minimum
          }

          await new Promise(r => setTimeout(r, pollIntervalMs));
        }

        if (!cancelled) {
          // If the switch failed the store was already reverted; don't reconnect to an
          // invalid camera — just restore the current working stream.
          setMjpegUrl(buildMjpegUrl(Date.now()));
        }
      };

      pollAndConnect();

      // Safety: hide loading spinner after 7s regardless
      const hideTimer = setTimeout(() => {
        setStreamLoading(l => l ? false : l);
      }, 7000);

      return () => {
        cancelled = true;
        clearTimeout(hideTimer);
      };
    }
  }, [cameraSource]);

  const handleStreamLoad = useCallback(() => {
    setStreamLoading(false);
    setStreamError(false);
    lastFrameTimeRef.current = Date.now();
  }, []);

  const handleStreamError = useCallback(() => {
    setStreamLoading(false);
    setStreamError(true);
  }, []);


  // MJPEG streams can silently stall; periodic reconnect keeps the feed alive.
  useEffect(() => {
    const refreshTimer = window.setInterval(() => {
      if (!streamLoading) {
        setStreamTs(Date.now());
      }
    }, MJPEG_REFRESH_MS);
    return () => window.clearInterval(refreshTimer);
  }, [streamLoading]);

  // Stall watchdog: if the stream hasn't delivered a new frame in MJPEG_STALL_TIMEOUT_MS,
  // force-reconnect. This handles the silent freeze that MJPEG connections get on macOS
  // after ~2-3 minutes without triggering onerror.
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
            title="Restore default layout"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          {isEditing ? (
            <button
              onClick={saveLayout}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-500"
              title="Save custom layout"
            >
              <Save className="w-3.5 h-3.5" />
              Save
            </button>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-500"
              title="Edit and resize panels"
            >
              <Edit3 className="w-3.5 h-3.5" />
              Edit layout
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
          <div
            className="bg-black rounded-xl border border-gray-800 shadow-lg overflow-hidden group relative h-full min-h-[260px]"
            onMouseEnter={handleVideoEnter}
            onMouseLeave={handleVideoLeave}
          >
            {/* Top controls bar */}
            <div className="absolute top-0 left-0 right-0 p-3 bg-gradient-to-b from-black/80 to-transparent z-20 flex justify-between items-center opacity-0 group-hover:opacity-100 transition-opacity">
              <h2 className="font-semibold flex items-center gap-2 text-white text-xs">
                <Video className="w-3 h-3 text-red-500" /> Live Feed
                {typeof cameraSource === 'number' && (
                  <span className="text-[10px] text-sky-400 font-mono">cam {cameraSource}</span>
                )}
              </h2>
              <button
                onClick={() => window.open(mjpegUrl, '_blank')}
                className="text-white/80 hover:text-white bg-white/10 p-1.5 rounded-lg backdrop-blur-sm transition-colors"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
            </div>

            {/* Video stream */}
            <div className="w-full h-full flex items-center justify-center bg-slate-900 relative">
              {/* Loading overlay while stream initialises */}
              {streamLoading && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-900/90 gap-2">
                  <Loader className="w-7 h-7 text-sky-400 animate-spin" />
                  <span className="text-xs text-slate-400">
                    Switching to cam {typeof cameraSource === 'number' ? cameraSource : '…'}
                  </span>
                </div>
              )}

              {/* No-signal placeholder when stream fails */}
              {streamError && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950 gap-3 px-4 text-center">
                  <WifiOff className="w-8 h-8 text-red-400" />
                  <span className="text-xs text-slate-300 font-semibold">MJPEG server not reachable</span>
                  <span className="text-[10px] text-slate-500 font-mono">{MJPEG_BASE}</span>
                  <span className="text-[10px] text-slate-500 leading-relaxed">
                    Make sure <span className="text-sky-400 font-mono">pose_detection.py</span> is running.<br/>
                    If it just stopped, port 8001 may still be held — run:<br/>
                    <span className="text-yellow-400 font-mono">lsof -i :8001</span> then kill the PID.
                  </span>
                  <button
                    onClick={() => { setStreamError(false); setStreamLoading(true); setStreamTs(Date.now()); }}
                    className="mt-1 text-[10px] px-3 py-1 rounded bg-slate-800 text-sky-400 hover:bg-slate-700 border border-slate-700"
                  >Retry</button>
                </div>
              )}

              {mjpegUrl ? (
                <img
                  key={mjpegUrl}
                  src={mjpegUrl}
                  alt="Live Stream"
                  className="w-full h-full object-contain"
                  loading="eager"
                  onLoad={handleStreamLoad}
                  onError={handleStreamError}
                />
              ) : null}
              {/* Badges hidden when picker is open so they don't overlap */}
              {!videoHovered && !streamLoading && !streamError && (
                <div className="absolute bottom-2 right-2 flex gap-1 z-10">
                  <span className="px-1.5 py-0.5 bg-red-600 text-white text-[10px] font-bold rounded uppercase">Live</span>
                  <span className="px-1.5 py-0.5 bg-gray-800 text-gray-300 text-[10px] font-mono rounded">MJPEG</span>
                </div>
              )}
            </div>

            {/* Camera picker – slides up on hover */}
            <CameraHoverPicker
              visible={videoHovered && !isEditing}
              onMouseEnter={handleVideoEnter}
              onMouseLeave={handleVideoLeave}
            />
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

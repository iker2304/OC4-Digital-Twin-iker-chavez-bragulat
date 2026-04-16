import { useEffect, useState } from 'react';
import { Camera, CheckCircle2, Loader2, VideoOff } from 'lucide-react';
import { useTwinStore } from '../../store/twinStore';

const BACKEND_BASE = 'http://localhost:8080';

type CameraStatus = 'available' | 'unavailable' | 'unknown';
const availableCameras = [0, 1, 2, 3, 4];

interface CameraEntry {
  index: number;
  status: CameraStatus;
}

// Only explicitly unavailable cameras are blocked; unknown = selectable
function isSelectable(status: CameraStatus) {
  return status !== 'unavailable';
}

function CameraCard({
  entry,
  active,
  onSelect,
}: {
  entry: CameraEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const selectable = isSelectable(entry.status);

  return (
    <button
      onClick={selectable ? onSelect : undefined}
      disabled={!selectable}
      title={
        !selectable
          ? `Camera ${entry.index} unavailable`
          : active
          ? `Active — Camera ${entry.index}`
          : `Switch to Camera ${entry.index}`
      }
      className={[
        'relative flex-shrink-0 flex flex-col items-center justify-center gap-1.5',
        'w-16 h-16 rounded-xl border-2 transition-all duration-150 select-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
        active
          ? 'border-sky-400 bg-sky-500/20 shadow-[0_0_10px_rgba(56,189,248,0.3)]'
          : !selectable
          ? 'border-slate-700 bg-slate-900/60 opacity-40 cursor-not-allowed'
          : 'border-slate-600 bg-slate-800/80 hover:border-sky-500 hover:bg-sky-950/60 cursor-pointer',
      ].join(' ')}
    >
      {/* Icon */}
      {!selectable ? (
        <VideoOff className="w-5 h-5 text-slate-500" />
      ) : (
        <Camera className={`w-5 h-5 ${active ? 'text-sky-300' : 'text-slate-300'}`} />
      )}

      {/* Index label */}
      <span
        className={`text-[11px] font-bold leading-none ${
          active ? 'text-sky-300' : !selectable ? 'text-slate-600' : 'text-slate-300'
        }`}
      >
        Cam {entry.index}
      </span>

      {/* Active checkmark badge */}
      {active && (
        <CheckCircle2 className="absolute top-1 right-1 w-3 h-3 text-sky-400" />
      )}
    </button>
  );
}

/** Slides up from the bottom of the video panel on hover. */
export function CameraHoverPicker({
  visible,
  onMouseEnter,
  onMouseLeave,
}: {
  visible: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const cameraSource = useTwinStore((s) => s.cameraSource);
  const setCameraSource = useTwinStore((s) => s.setCameraSource);

  const [cameras, setCameras] = useState<CameraEntry[]>([]);
  const [scanStatus, setScanStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    setScanStatus('loading');

    fetch(`${BACKEND_BASE}/cameras?max_index=5`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ cameras: CameraEntry[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        const list = (data.cameras && data.cameras.length > 0
          ? data.cameras
          : [{ index: 0, status: 'unknown' as const }]).filter(c => availableCameras.includes(c.index));
        setCameras(list);
        setScanStatus('idle');
      })
      .catch(() => {
        if (cancelled) return;
        setCameras([
          { index: 0, status: 'unknown' },
          { index: 1, status: 'unknown' },
          { index: 2, status: 'unknown' },
          { index: 3, status: 'unknown' },
          { index: 4, status: 'unknown' },
        ]);
        setScanStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeIndex = typeof cameraSource === 'number' ? cameraSource : -1;

  return (
    <div
      className={[
        'absolute bottom-0 inset-x-0 z-20',
        'transition-all duration-200 ease-out',
        visible
          ? 'translate-y-0 opacity-100 pointer-events-auto'
          : 'translate-y-3 opacity-0 pointer-events-none',
      ].join(' ')}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="bg-gradient-to-t from-black/95 via-black/80 to-transparent px-3 pt-8 pb-3">
        {/* Header */}
        <div className="flex items-center gap-1.5 mb-2.5">
          <Camera className="w-3 h-3 text-sky-400" />
          <span className="text-[10px] font-semibold text-sky-300 uppercase tracking-widest">
            Camera source
          </span>
          {scanStatus === 'loading' && (
            <Loader2 className="w-3 h-3 text-slate-500 animate-spin ml-1" />
          )}
          {scanStatus === 'error' && (
            <span className="text-[10px] text-amber-400 ml-1">· backend offline</span>
          )}
        </div>

        {/* Cards */}
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {cameras.map((cam) => (
            <CameraCard
              key={cam.index}
              entry={cam}
              active={cam.index === activeIndex}
              onSelect={() => {
                if (cam.index !== activeIndex) {
                  setCameraSource(cam.index);
                }
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

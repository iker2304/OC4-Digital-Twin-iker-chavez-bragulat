import { useEffect, useState } from 'react';
import { Camera, Check, Loader2, VideoOff } from 'lucide-react';
import { useTwinStore } from '../../store/twinStore';
import { API_BASE_URL } from '../../config/api';

const BACKEND_BASE = API_BASE_URL;

type CameraStatus = 'available' | 'unavailable' | 'unknown';
const availableCameras = [0, 1, 2, 3, 4];

interface CameraEntry {
  index: number;
  status: CameraStatus;
}

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
          ? `Cámara ${entry.index} no disponible`
          : active
          ? `Cámara ${entry.index} activa`
          : `Cambiar a cámara ${entry.index}`
      }
      className={[
        'relative flex h-12 w-14 shrink-0 select-none flex-col items-center justify-center gap-1 rounded-lg border text-xs transition-colors',
        active
          ? 'border-white bg-zinc-800 text-white'
          : !selectable
          ? 'cursor-not-allowed border-zinc-800 bg-zinc-900/50 text-zinc-600 opacity-50'
          : 'cursor-pointer border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800',
      ].join(' ')}
    >
      {!selectable ? <VideoOff className="h-3.5 w-3.5" /> : <Camera className="h-3.5 w-3.5" />}
      <span className="text-[10px] font-medium leading-none">Cam {entry.index}</span>
      {active && <Check className="absolute right-1 top-1 h-2.5 w-2.5 text-white" />}
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
        'absolute inset-x-0 bottom-0 z-20 transition-all duration-150',
        visible ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      ].join(' ')}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="border-t border-zinc-800 bg-zinc-950/95 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
          <Camera className="h-3 w-3" />
          <span>Fuente de cámara</span>
          {scanStatus === 'loading' && <Loader2 className="ml-1 h-3 w-3 animate-spin text-zinc-500" />}
          {scanStatus === 'error' && <span className="ml-1 text-[10px] text-amber-400">· sin conexión</span>}
        </div>

        <div className="flex gap-1.5 overflow-x-auto">
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

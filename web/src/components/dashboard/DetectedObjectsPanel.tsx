import { useTwinStore } from '../../store/twinStore';
import { Target, MapPin } from 'lucide-react';
import { Badge, Card } from '../ui';

type DetectionItem = {
  id?: string | number;
  label?: string;
  class?: string;
  x?: number;
  y?: number;
  confidence?: number;
};

type OverlayDataWithDetections = {
  detections?: DetectionItem[];
};

const isDetectionList = (value: unknown): value is DetectionItem[] => Array.isArray(value);

export const DetectedObjectsPanel = () => {
  const { video } = useTwinStore();
  const { keypoints = [], overlayData = {} } = video || {};
  const overlayDetections = (overlayData as OverlayDataWithDetections)?.detections;
  const detections: DetectionItem[] = isDetectionList(overlayDetections)
    ? overlayDetections
    : keypoints.map((kp) => ({ id: kp.id, x: kp.x, y: kp.y }));

  return (
    <Card className="flex h-full max-h-[400px] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
          <Target className="h-4 w-4 text-zinc-400" strokeWidth={1.75} />
          Objetos detectados
        </h3>
        <Badge tone="neutral">{detections.length}</Badge>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
        {detections.length === 0 ? (
          <div className="flex h-full min-h-[96px] items-center justify-center text-xs text-zinc-400">
            Sin objetos detectados
          </div>
        ) : (
          detections.map((det, idx: number) => (
            <div
              key={det.id || idx}
              className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800"
            >
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {det.label || det.class || `Objeto ${det.id || idx + 1}`}
                </p>
                <p className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-zinc-500">
                  <MapPin className="h-3 w-3" />
                  X: {typeof det.x === 'number' ? det.x.toFixed(2) : '—'} · Y:{' '}
                  {typeof det.y === 'number' ? det.y.toFixed(2) : '—'}
                </p>
              </div>

              {det.confidence && <Badge tone="success">{(det.confidence * 100).toFixed(0)}%</Badge>}
            </div>
          ))
        )}
      </div>
    </Card>
  );
};

import { useTwinStore } from '../../store/twinStore';
import { Target, MapPin, Activity } from 'lucide-react';

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

const isDetectionList = (value: unknown): value is DetectionItem[] => {
  return Array.isArray(value);
};

export const DetectedObjectsPanel = () => {
  const { video } = useTwinStore();
  const { keypoints = [], overlayData = {} } = video || {};
  const overlayDetections = (overlayData as OverlayDataWithDetections)?.detections;
  const detections: DetectionItem[] = isDetectionList(overlayDetections)
    ? overlayDetections
    : keypoints.map((kp) => ({ id: kp.id, x: kp.x, y: kp.y }));

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col h-full max-h-[400px]">
      <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex justify-between items-center bg-gray-50 dark:bg-slate-900/50">
        <h3 className="font-semibold flex items-center gap-2 text-gray-800 dark:text-white">
          <Target className="w-4 h-4 text-red-500" /> 
          Detected Objects
          <span className="ml-2 text-xs bg-gray-200 dark:bg-slate-700 px-2 py-0.5 rounded-full text-gray-600 dark:text-gray-300">
            {detections.length}
          </span>
        </h3>
      </div>
      
      <div className="overflow-y-auto p-2 space-y-2 flex-1">
        {detections.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-400 text-sm">
            <Activity className="w-8 h-8 mb-2 opacity-20" />
            <p>No objects detected</p>
          </div>
        ) : (
          detections.map((det, idx: number) => (
            <div 
              key={det.id || idx}
              className="bg-gray-50 dark:bg-slate-700/50 rounded-lg p-3 border border-gray-100 dark:border-slate-600 flex justify-between items-center group hover:border-blue-500 transition-colors"
            >
              <div className="flex flex-col">
                <span className="font-medium text-sm text-gray-700 dark:text-gray-200">
                  {det.label || det.class || `Object ${det.id || idx + 1}`}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400 font-mono flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  X: {typeof det.x === 'number' ? det.x.toFixed(2) : 'N/A'}, 
                  Y: {typeof det.y === 'number' ? det.y.toFixed(2) : 'N/A'}
                </span>
              </div>
              
              {det.confidence && (
                <div className="text-xs font-bold text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-2 py-1 rounded">
                  {(det.confidence * 100).toFixed(0)}%
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

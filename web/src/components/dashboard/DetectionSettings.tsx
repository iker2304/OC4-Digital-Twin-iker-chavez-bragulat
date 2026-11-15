import { useState } from 'react';
import { useTwinStore } from '../../store/twinStore';
import type { TwinConfigUpdate } from '../../types';
import { SlidersHorizontal } from 'lucide-react';
import { Button, Card } from '../ui';

export const DetectionSettings = () => {
  const updateConfig = useTwinStore((state) => state.updateConfig);

  const [conf, setConf] = useState(0.25);
  const [iou, setIou] = useState(0.45);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showKpts, setShowKpts] = useState(true);
  const [recording, setRecording] = useState(false);
  const [recordingSpeed, setRecordingSpeed] = useState(1);

  const handleUpdate = (newSettings: TwinConfigUpdate) => {
    updateConfig(newSettings);
  };

  return (
    <Card className="flex h-full flex-col justify-between p-4">
      <div>
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
          <SlidersHorizontal className="h-4 w-4 text-zinc-400" strokeWidth={1.75} />
          Parámetros de detección
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <div className="mb-1 flex justify-between text-xs text-zinc-500">
              <span>Confianza</span>
              <span className="font-mono text-zinc-700 dark:text-zinc-300">{conf.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.01"
              max="1"
              step="0.01"
              value={conf}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setConf(val);
                handleUpdate({ conf: val });
              }}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-200 accent-zinc-900 dark:bg-zinc-800 dark:accent-zinc-100"
            />
          </div>

          <div>
            <div className="mb-1 flex justify-between text-xs text-zinc-500">
              <span>Umbral IoU</span>
              <span className="font-mono text-zinc-700 dark:text-zinc-300">{iou.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0.01"
              max="1"
              step="0.01"
              value={iou}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setIou(val);
                handleUpdate({ iou: val });
              }}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-200 accent-zinc-900 dark:bg-zinc-800 dark:accent-zinc-100"
            />
          </div>

          <div>
            <div className="mb-1 flex justify-between text-xs text-zinc-500">
              <span>Velocidad</span>
              <span className="font-mono text-zinc-700 dark:text-zinc-300">{recordingSpeed}x</span>
            </div>
            <input
              type="range"
              min="0.25"
              max="4"
              step="0.25"
              value={recordingSpeed}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setRecordingSpeed(val);
                handleUpdate({ recording_speed: val });
              }}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-200 accent-zinc-900 dark:bg-zinc-800 dark:accent-zinc-100"
            />
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={showBoxes ? 'primary' : 'secondary'}
          onClick={() => {
            const val = !showBoxes;
            setShowBoxes(val);
            handleUpdate({ show_boxes: val });
          }}
        >
          {showBoxes ? 'Ocultar cajas' : 'Mostrar cajas'}
        </Button>

        <Button
          size="sm"
          variant={showKpts ? 'primary' : 'secondary'}
          onClick={() => {
            const val = !showKpts;
            setShowKpts(val);
            handleUpdate({ show_kpts: val });
          }}
        >
          {showKpts ? 'Ocultar keypoints' : 'Mostrar keypoints'}
        </Button>

        <Button
          size="sm"
          variant={recording ? 'danger' : 'secondary'}
          onClick={() => {
            const val = !recording;
            setRecording(val);
            handleUpdate({ recording: val });
          }}
        >
          {recording ? 'Detener grabación' : 'Grabar'}
        </Button>
      </div>
    </Card>
  );
};

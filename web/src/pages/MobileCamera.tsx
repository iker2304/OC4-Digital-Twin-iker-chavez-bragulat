import { useEffect, useRef, useState } from 'react';
import { Button, StatusDot } from '../components/ui';
import { Camera, RefreshCw } from 'lucide-react';

export default function MobileCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'initializing' | 'streaming' | 'error'>('initializing');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let intervalId: number;

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error(
            'Browser does not support camera access on insecure origins. Use HTTPS or enable the "Insecure origins treated as secure" flag.'
          );
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        const protocol = 'ws:';
        const host = window.location.hostname;
        const port = 8080;
        const wsUrl = `${protocol}//${host}:${port}/ws/mobile-stream`;

        wsRef.current = new WebSocket(wsUrl);

        wsRef.current.onopen = () => {
          setStatus('streaming');
          intervalId = window.setInterval(sendFrame, 100);
        };

        wsRef.current.onerror = () => {
          setStatus('error');
          setErrorMsg('WebSocket connection error');
        };

        wsRef.current.onclose = () => {
          setStatus('error');
          setErrorMsg('WebSocket connection closed');
        };
      } catch (err) {
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    };

    const sendFrame = () => {
      if (videoRef.current && canvasRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        const ctx = canvas.getContext('2d');

        if (ctx) {
          if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = canvas.toDataURL('image/jpeg', 0.6);
          wsRef.current.send(imageData);
        }
      }
    };

    startCamera();

    return () => {
      if (intervalId) clearInterval(intervalId);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col items-center justify-center text-white p-6">
      <div className="flex items-center gap-2 mb-4">
        <Camera className="w-4 h-4 text-blue-400" />
        <h1 className="text-sm font-semibold tracking-tight">Mobile Camera Stream</h1>
      </div>

      <div className="relative w-full max-w-md aspect-video bg-slate-900 rounded-xl overflow-hidden border border-slate-800">
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        <canvas ref={canvasRef} className="hidden" />

        {status === 'initializing' && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 text-xs text-slate-300">
            <span>Inicializando cámara...</span>
          </div>
        )}
      </div>

      <div className="mt-5 text-center">
        {status === 'streaming' && (
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
            <StatusDot status="online" pulse />
            <span>Transmitiendo al gemelo digital</span>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-3">
            <p className="text-xs text-red-400">Error: {errorMsg}</p>
            <Button variant="danger" size="sm" onClick={() => window.location.reload()}>
              <RefreshCw className="w-3.5 h-3.5" /> Reintentar
            </Button>
          </div>
        )}
      </div>

      <p className="mt-6 text-xs text-slate-400 max-w-xs text-center">
        Mantén esta página abierta y el teléfono desbloqueado para continuar la transmisión.
      </p>
    </div>
  );
}

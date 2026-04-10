import { useEffect, useRef, useState } from 'react';

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
          throw new Error('Browser does not support camera access on insecure origins. Use HTTPS or enable the "Insecure origins treated as secure" flag.');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        // Connect to WebSocket - Backend is HTTP/WS
        const protocol = 'ws:'; 
        const host = window.location.hostname;
        const port = 8080; // Backend port
        const wsUrl = `${protocol}//${host}:${port}/ws/mobile-stream`;
        
        wsRef.current = new WebSocket(wsUrl);

        wsRef.current.onopen = () => {
          setStatus('streaming');
          // Start sending frames
          intervalId = window.setInterval(sendFrame, 100); // 10 FPS
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
          // Set canvas size to match video
          if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = canvas.toDataURL('image/jpeg', 0.6); // Compress 60%
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
        stream.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center text-white p-4">
      <h1 className="text-xl font-bold mb-4">Mobile Camera Stream</h1>
      
      <div className="relative w-full max-w-md aspect-video bg-gray-900 rounded-lg overflow-hidden border-2 border-gray-700">
        <video 
          ref={videoRef} 
          autoPlay 
          playsInline 
          muted 
          className="w-full h-full object-cover"
        />
        <canvas ref={canvasRef} className="hidden" />
        
        {status === 'initializing' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <span>Initializing camera...</span>
          </div>
        )}
      </div>

      <div className="mt-6 text-center">
        {status === 'streaming' && (
          <div className="flex items-center gap-2 text-green-400">
            <div className="w-3 h-3 bg-green-400 rounded-full animate-pulse" />
            <span>Streaming to Digital Twin</span>
          </div>
        )}
        
        {status === 'error' && (
          <div className="text-red-400">
            <p>Error: {errorMsg}</p>
            <button 
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-red-600 rounded-lg hover:bg-red-500 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      <p className="mt-8 text-sm text-gray-400 max-w-xs text-center">
        Keep this page open and your phone unlocked to continue streaming.
      </p>
    </div>
  );
}

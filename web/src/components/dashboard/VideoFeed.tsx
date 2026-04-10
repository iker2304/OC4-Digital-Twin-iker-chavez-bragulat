import { useTwinStore } from '../../store/twinStore';
import { useEffect, useState } from 'react';

export const VideoFeed = () => {
  const { video } = useTwinStore();
  const [streamStatus, setStreamStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  // Use the detection script's stream directly
  const VIDEO_URL = "http://127.0.0.1:8001/video_feed";

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setStreamStatus((status) => (status === 'ready' ? status : 'error'));
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [VIDEO_URL]);

  return (
    <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden border border-gray-700">
       {streamStatus !== 'error' ? (
         <img 
           src={VIDEO_URL} 
           alt="Live Feed" 
           className="w-full h-full object-cover"
           onLoad={() => setStreamStatus('ready')}
           onError={() => setStreamStatus('error')}
         />
       ) : (
         <div className="absolute inset-0 flex items-center justify-center text-gray-500 bg-gray-900">
            <div className="text-center">
              <p className="mb-2">No Video Signal</p>
              <p className="text-xs">Stream http://localhost:8001/video_feed</p>
            </div>
         </div>
       )}
       {streamStatus === 'loading' ? (
         <div className="absolute inset-0 flex items-center justify-center text-gray-400 bg-black/40">
           <p className="text-xs">Conectando a la cámara...</p>
         </div>
       ) : null}

       {/* Overlay */}
       <svg className="absolute top-0 left-0 w-full h-full pointer-events-none">
         {video.keypoints.map((kp) => (
           <circle 
             key={kp.id} 
             cx={kp.x} 
             cy={kp.y} 
             r="8" 
             fill="yellow" 
             stroke="black" 
             strokeWidth="2"
           />
         ))}
       </svg>
       <div className="absolute top-2 right-2 bg-black/50 px-2 py-1 rounded text-xs text-white z-10">
         Live Feed
       </div>
    </div>
  );
};

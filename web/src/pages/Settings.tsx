import { useEffect, useMemo, useState } from 'react';
import { useTwinStore } from '../store/twinStore';
import { QRCodeSVG } from 'qrcode.react';

type CameraMode = 'device' | 'rtsp' | 'mobile';
type ThemeMode = 'dark' | 'light';

export default function Settings() {
  const connect = useTwinStore((state) => state.connect);
  const isConnected = useTwinStore((state) => state.isConnected);
  const cameraSource = useTwinStore((state) => state.cameraSource);
  const setCameraSource = useTwinStore((state) => state.setCameraSource);
  const system = useTwinStore((state) => state.system);

  const [showMobileQR, setShowMobileQR] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const [availableCameras, setAvailableCameras] = useState<Array<{ index: number; status: 'available' | 'unavailable' | 'unknown' }> | null>(
    null
  );
  const [cameraScanStatus, setCameraScanStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  const [mode, setMode] = useState<CameraMode>(() => {
    if (cameraSource === 'mobile') return 'mobile';
    if (typeof cameraSource === 'number') return 'device';
    const s = String(cameraSource).trim();
    if (s.startsWith('rtsp://')) return 'rtsp';
    if (/^\d+$/.test(s)) return 'device';
    return 'rtsp';
  });
  const [deviceId, setDeviceId] = useState(() => {
    if (typeof cameraSource === 'number') return String(cameraSource);
    const s = String(cameraSource).trim();
    if (/^\d+$/.test(s)) return s;
    return '0';
  });
  const [rtspUrl, setRtspUrl] = useState(() => {
    if (typeof cameraSource === 'string' && cameraSource.trim().length > 0) return cameraSource.trim();
    return '';
  });

  const source = useMemo(() => {
    if (mode === 'mobile') return 'mobile';
    return mode === 'device' ? Number(deviceId) : rtspUrl.trim();
  }, [mode, deviceId, rtspUrl]);

  const canApply = mode === 'mobile' ? true : (mode === 'device' ? Number.isFinite(Number(deviceId)) : rtspUrl.trim().length > 0);

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    localStorage.setItem('theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    const loadCameras = async () => {
      setCameraScanStatus('loading');
      try {
        const res = await fetch('http://localhost:8080/cameras?max_index=10');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { cameras: Array<{ index: number; status: 'available' | 'unavailable' | 'unknown' }> };
        if (cancelled) return;
        setAvailableCameras(data.cameras);
        setCameraScanStatus('idle');
      } catch {
        if (cancelled) return;
        setAvailableCameras(null);
        setCameraScanStatus('error');
      }
    };

    loadCameras();
    return () => {
      cancelled = true;
    };
  }, []);

  const getConnectionUrl = () => {
    // Prefer the hostname currently in the browser address bar if it's an IP or network name
    const currentHost = window.location.hostname;
    const isLocalhost = currentHost === 'localhost' || currentHost === '127.0.0.1';
    
    const ip = !isLocalhost 
      ? currentHost 
      : (system?.localIp && system.localIp !== 'localhost' ? system.localIp : '');
    
    if (!ip) return null;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    return `${window.location.protocol}//${ip}:${port}/mobile-camera`;
  };

  const connectionUrl = getConnectionUrl();

  return (
    <div className="max-w-2xl space-y-6">
      <div className="bg-white p-4 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
        <h3 className="text-lg font-bold mb-4">Appearance</h3>

        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-gray-600 dark:text-slate-300">Theme</div>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeMode)}
            className="bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>

        <div className="mt-2 text-xs text-gray-500 dark:text-slate-400">Saved in your browser for next time.</div>
      </div>

      <div className="bg-white p-4 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
        <h3 className="text-lg font-bold mb-4">Mobile Camera Connection</h3>
        <p className="text-sm text-gray-600 dark:text-slate-300 mb-4">
          Use your phone as a wireless camera for pose detection.
        </p>
        
        {!showMobileQR ? (
          <button
            onClick={() => setShowMobileQR(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-sm font-medium transition-colors"
          >
            Show Connection QR
          </button>
        ) : (
          <div className="flex flex-col items-center gap-4 p-4 bg-gray-50 dark:bg-slate-900 rounded-lg">
            {connectionUrl ? (
              <>
                <div className="bg-white p-4 rounded-lg">
                  <QRCodeSVG value={connectionUrl} size={200} />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium">Scan this QR with your phone</p>
                  <p className="text-xs text-gray-500 mt-1">
                    Make sure your phone is on the same WiFi network.
                  </p>
                  <p className="text-xs font-mono mt-2 text-blue-500">
                    {connectionUrl}
                  </p>
                </div>
              </>
            ) : (
              <div className="text-center p-4">
                <p className="text-sm text-red-500 font-medium">Could not detect local IP</p>
                <p className="text-xs text-gray-500 mt-2">
                  Access the dashboard using your PC's IP address (e.g., http://192.168.1.50:5173) 
                  instead of localhost to enable mobile connection.
                </p>
              </div>
            )}
            <button
              onClick={() => setShowMobileQR(false)}
              className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
            >
              Hide QR
            </button>
          </div>
        )}
      </div>

      <div className="bg-white p-4 rounded-lg shadow-lg border border-gray-200 text-gray-900 dark:bg-slate-800 dark:border-slate-700 dark:text-white">
        <h3 className="text-lg font-bold mb-4">Camera Settings</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="block text-sm">Source Type</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as CameraMode | 'mobile')}
              className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
            >
              <option value="device">Local camera (0/1/2...)</option>
              <option value="rtsp">IP camera (RTSP)</option>
              <option value="mobile">Mobile Camera (QR)</option>
            </select>
          </div>

          {mode === 'mobile' ? (
            <div className="space-y-2">
              <label className="block text-sm">Mobile Source</label>
              <div className="px-3 py-2 bg-gray-100 dark:bg-slate-900 rounded text-sm text-gray-500">
                Source will be set to "mobile"
              </div>
            </div>
          ) : mode === 'device' ? (
            <div className="space-y-2">
              <label className="block text-sm">Camera ID</label>
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
              >
                {(
                  availableCameras ?? [
                    { index: 0, status: 'unknown' as const },
                    { index: 1, status: 'unknown' as const },
                    { index: 2, status: 'unknown' as const },
                  ]
                ).map((cam) => (
                  <option key={cam.index} value={String(cam.index)}>
                    {cam.index}
                    {cam.status === 'available' ? ' (available)' : cam.status === 'unknown' ? ' (unknown)' : ' (unavailable)'}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="block text-sm">RTSP URL</label>
              <input
                value={rtspUrl}
                onChange={(e) => setRtspUrl(e.target.value)}
                placeholder="rtsp://user:pass@ip:554/stream"
                className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-gray-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-gray-600 dark:text-slate-300">
            Current: <span className="font-semibold">{String(cameraSource)}</span> · Selected:{' '}
            <span className="font-semibold">{String(source)}</span>
          </div>

          <button
            disabled={!isConnected || !canApply}
            onClick={() => {
              setCameraSource(source);
            }}
            className="px-3 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500"
          >
            Apply
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-gray-500 dark:text-slate-400">
          <span>WebSocket: {isConnected ? 'Connected' : 'Disconnected'}</span>
          <button
            type="button"
            onClick={async () => {
              setCameraScanStatus('loading');
              try {
                const res = await fetch('http://localhost:8080/cameras?max_index=10');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as { cameras: Array<{ index: number; status: 'available' | 'unavailable' | 'unknown' }> };
                setAvailableCameras(data.cameras);
                setCameraScanStatus('idle');
              } catch {
                setAvailableCameras(null);
                setCameraScanStatus('error');
              }
            }}
            className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-slate-700 dark:hover:bg-slate-600"
            disabled={cameraScanStatus === 'loading'}
          >
            {cameraScanStatus === 'loading' ? 'Scanning…' : 'Refresh camera list'}
          </button>
        </div>

        <div className="mt-2 text-xs text-gray-500 dark:text-slate-400">
          If a camera is in use by another process, probing may show it as “not detected”.
        </div>

        {cameraScanStatus === 'error' ? (
          <div className="mt-2 text-xs text-red-300">
            Could not load camera list from backend. Make sure `backend` is running on `http://localhost:8080`.
          </div>
        ) : null}

      </div>
    </div>
  );
}

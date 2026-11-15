import { useEffect, useMemo, useState } from 'react';
import { useTwinStore } from '../store/twinStore';
import { QRCodeSVG } from 'qrcode.react';
import { API_BASE_URL } from '../config/api';
import { useTheme, type ThemeMode } from '../lib/theme';
import { Button, Card, CardHeader, PageHeader, StatusDot } from '../components/ui';
import { Camera, QrCode, RefreshCw, Sun, Moon } from 'lucide-react';

type CameraMode = 'device' | 'rtsp' | 'mobile';

export default function Settings() {
  const connect = useTwinStore((state) => state.connect);
  const isConnected = useTwinStore((state) => state.isConnected);
  const cameraSource = useTwinStore((state) => state.cameraSource);
  const setCameraSource = useTwinStore((state) => state.setCameraSource);
  const system = useTwinStore((state) => state.system);

  const [showMobileQR, setShowMobileQR] = useState(false);
  const { theme, setTheme } = useTheme();

  const [availableCameras, setAvailableCameras] = useState<
    Array<{ index: number; status: 'available' | 'unavailable' | 'unknown' }> | null
  >(null);
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

  const canApply =
    mode === 'mobile' ? true : mode === 'device' ? Number.isFinite(Number(deviceId)) : rtspUrl.trim().length > 0;

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    let cancelled = false;

    const loadCameras = async () => {
      setCameraScanStatus('loading');
      try {
        const res = await fetch(`${API_BASE_URL}/cameras?max_index=10`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          cameras: Array<{ index: number; status: 'available' | 'unavailable' | 'unknown' }>;
        };
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
    const currentHost = window.location.hostname;
    const isLocalhost = currentHost === 'localhost' || currentHost === '127.0.0.1';

    const ip = !isLocalhost
      ? currentHost
      : system?.localIp && system.localIp !== 'localhost'
        ? system.localIp
        : '';

    if (!ip) return null;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    return `${window.location.protocol}//${ip}:${port}/mobile-camera`;
  };

  const connectionUrl = getConnectionUrl();

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        eyebrow="Sistema"
        title="Ajustes de la plataforma"
        description="Configura la apariencia de la interfaz, la fuente de vídeo para detección de pose y la conexión inalámbrica."
      />

      <Card className="p-5">
        <CardHeader
          title="Apariencia"
          subtitle="La preferencia de tema se sincroniza y guarda automáticamente en tu navegador."
          actions={theme === 'dark' ? <Moon className="w-4 h-4 text-gray-400" /> : <Sun className="w-4 h-4 text-gray-400" />}
        />

        <div className="flex items-center justify-between gap-4">
          <div className="text-xs font-medium text-gray-700 dark:text-slate-300">Tema de color</div>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeMode)}
            className="ui-input w-44"
          >
            <option value="dark">Oscuro (Dark)</option>
            <option value="light">Claro (Light)</option>
          </select>
        </div>
      </Card>

      <Card className="p-5">
        <CardHeader
          title="Conexión de cámara móvil"
          subtitle="Utiliza un teléfono en la misma red Wi-Fi como cámara inalámbrica para estimación de pose."
          actions={<QrCode className="w-4 h-4 text-gray-400" />}
        />

        {!showMobileQR ? (
          <Button variant="primary" size="sm" onClick={() => setShowMobileQR(true)}>
            <QrCode className="w-3.5 h-3.5" /> Mostrar código QR de conexión
          </Button>
        ) : (
          <div className="flex flex-col items-center gap-4 p-5 bg-gray-50 dark:bg-slate-800/50 rounded-xl border border-gray-200 dark:border-slate-800">
            {connectionUrl ? (
              <>
                <div className="bg-white p-4 rounded-lg border border-gray-200">
                  <QRCodeSVG value={connectionUrl} size={180} />
                </div>
                <div className="text-center">
                  <p className="text-xs font-medium text-gray-900 dark:text-white">Escanea este código con tu dispositivo móvil</p>
                  <p className="text-[11px] text-gray-500 mt-1">
                    Asegúrate de que ambos dispositivos estén en la misma red local.
                  </p>
                  <p className="text-xs font-mono mt-2 text-blue-600 dark:text-blue-400">{connectionUrl}</p>
                </div>
              </>
            ) : (
              <div className="text-center p-2">
                <p className="text-xs text-red-500 font-medium">No se pudo detectar la IP local</p>
                <p className="text-[11px] text-gray-500 mt-1 max-w-md">
                  Accede al panel usando la dirección IP de tu equipo (ej. `http://192.168.1.50:5173`) en lugar de
                  `localhost` para habilitar el enlace móvil.
                </p>
              </div>
            )}
            <Button variant="ghost" size="xs" onClick={() => setShowMobileQR(false)}>
              Ocultar código QR
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <CardHeader
          title="Fuente de cámara"
          subtitle="Selecciona el dispositivo de captura para el pipeline de visión artificial."
          actions={<Camera className="w-4 h-4 text-gray-400" />}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="ui-label">Tipo de fuente</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as CameraMode | 'mobile')}
              className="ui-input"
            >
              <option value="device">Cámara local (0/1/2...)</option>
              <option value="rtsp">Cámara IP (RTSP)</option>
              <option value="mobile">Cámara móvil (QR)</option>
            </select>
          </div>

          {mode === 'mobile' ? (
            <div>
              <label className="ui-label">Fuente móvil</label>
              <div className="ui-input bg-gray-50 dark:bg-slate-800/60 text-gray-500 flex items-center">
                Fuente configurada como &quot;mobile&quot;
              </div>
            </div>
          ) : mode === 'device' ? (
            <div>
              <label className="ui-label">ID de cámara</label>
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="ui-input">
                {(
                  availableCameras ?? [
                    { index: 0, status: 'unknown' as const },
                    { index: 1, status: 'unknown' as const },
                    { index: 2, status: 'unknown' as const },
                  ]
                ).map((cam) => (
                  <option key={cam.index} value={String(cam.index)}>
                    {cam.index}
                    {cam.status === 'available'
                      ? ' (disponible)'
                      : cam.status === 'unknown'
                        ? ' (desconocido)'
                        : ' (no disponible)'}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="ui-label">URL RTSP</label>
              <input
                value={rtspUrl}
                onChange={(e) => setRtspUrl(e.target.value)}
                placeholder="rtsp://user:pass@ip:554/stream"
                className="ui-input font-mono"
              />
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-slate-800 flex items-center justify-between">
          <div className="text-xs text-gray-600 dark:text-slate-300">
            Actual: <span className="font-mono font-semibold text-gray-900 dark:text-white">{String(cameraSource)}</span> · Seleccionada:{' '}
            <span className="font-mono font-semibold text-gray-900 dark:text-white">{String(source)}</span>
          </div>

          <Button
            variant="primary"
            size="sm"
            disabled={!isConnected || !canApply}
            onClick={() => {
              setCameraSource(source);
            }}
          >
            Aplicar fuente
          </Button>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-gray-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={isConnected ? 'online' : 'offline'} />
            WebSocket: {isConnected ? 'Conectado' : 'Desconectado'}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={cameraScanStatus === 'loading'}
            onClick={async () => {
              setCameraScanStatus('loading');
              try {
                const res = await fetch(`${API_BASE_URL}/cameras?max_index=10`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as {
                  cameras: Array<{ index: number; status: 'available' | 'unavailable' | 'unknown' }>;
                };
                setAvailableCameras(data.cameras);
                setCameraScanStatus('idle');
              } catch {
                setAvailableCameras(null);
                setCameraScanStatus('error');
              }
            }}
          >
            <RefreshCw className={`w-3 h-3 ${cameraScanStatus === 'loading' ? 'animate-spin' : ''}`} />
            {cameraScanStatus === 'loading' ? 'Escaneando...' : 'Actualizar lista de cámaras'}
          </Button>
        </div>

        <div className="mt-2 text-[11px] text-gray-400">
          Si una cámara está siendo utilizada por otro proceso, el sondeo puede mostrarla como no disponible.
        </div>

        {cameraScanStatus === 'error' ? (
          <div className="mt-2 text-xs text-red-500">
            No se pudo cargar la lista de cámaras del servidor (`{API_BASE_URL}`).
          </div>
        ) : null}
      </Card>
    </div>
  );
}

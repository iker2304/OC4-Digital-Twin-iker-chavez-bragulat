import { useEffect, useRef, useState, Suspense, lazy } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Anchor,
  TrendingUp,
  FileText,
  ArrowLeft,
  Edit2,
  Sliders,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { useTwinStore } from '../store/twinStore';
import { useProfileStore } from '../store/profileStore';
import type { SHMResponse } from '../types';
import type { FatigueDashboardConfig } from '../components/charts/AdvancedFatigueDashboard';
import StructuralTrendsChart from '../components/charts/StructuralTrendsChart';
import { Link } from 'react-router-dom';
import { Glyph } from '../components/ui/Glyph';
import { Badge, Button, Card, CardHeader, PageHeader, StatusDot } from '../components/ui';

const AdvancedFatigueDashboard = lazy(() => import('../components/charts/AdvancedFatigueDashboard'));

export default function SHMPage() {
  const {
    isConnected,
    structural,
    structuralHistory,
    physicsConfig,
    updatePhysicsConfig,
    envConditions,
    setEnvConditions,
    resetStructuralDamage,
  } = useTwinStore();
  const activeProfile = useProfileStore((s) => s.getActiveProfile());
  const [shmData, setShmData] = useState<SHMResponse | null>(null);
  const [throttledHistory, setThrottledHistory] = useState(structuralHistory);
  const [fatigueConfig, setFatigueConfig] = useState<FatigueDashboardConfig | undefined>(undefined);
  const [showPhysicsPanel, setShowPhysicsPanel] = useState(false);
  const [showLegacySection, setShowLegacySection] = useState(false);
  const latestStructuralHistoryRef = useRef(structuralHistory);

  useEffect(() => {
    let isActive = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCommit = 0;
    let rafId = 0;

    const connect = () => {
      if (!isActive) return;
      const wsUrl = `ws://${window.location.hostname}:8080/ws/shm`;
      socket = new WebSocket(wsUrl);

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as SHMResponse;
          if (rafId) {
            cancelAnimationFrame(rafId);
          }
          rafId = requestAnimationFrame((timestamp) => {
            if (!isActive) return;
            const refreshRate = fatigueConfig?.refreshRateMs ?? 250;
            if (timestamp - lastCommit >= refreshRate) {
              setShmData(data);
              lastCommit = timestamp;
            }
          });
        } catch (e) {
          console.error('Error parsing SHM data', e);
        }
      };

      socket.onerror = (e) => console.error('SHM WebSocket Error', e);
      socket.onclose = () => {
        if (!isActive) return;
        reconnectTimer = setTimeout(connect, 1200);
      };
    };

    connect();

    return () => {
      isActive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rafId) cancelAnimationFrame(rafId);
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
    };
  }, [fatigueConfig?.refreshRateMs]);

  useEffect(() => {
    latestStructuralHistoryRef.current = structuralHistory;
  }, [structuralHistory]);

  useEffect(() => {
    let isActive = true;
    let rafId = 0;
    let lastCommit = 0;
    const refreshRate = fatigueConfig?.refreshRateMs ?? 250;

    const tick = (timestamp: number) => {
      if (!isActive) return;
      if (timestamp - lastCommit >= refreshRate) {
        const nextHistory = latestStructuralHistoryRef.current;
        setThrottledHistory((prev) => {
          const lastPrev = prev[prev.length - 1];
          const lastNext = nextHistory[nextHistory.length - 1];
          const isUnchanged =
            prev.length === nextHistory.length &&
            lastPrev?.timestamp === lastNext?.timestamp;
          if (isUnchanged) return prev;
          return [...nextHistory];
        });
        lastCommit = timestamp;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      isActive = false;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [fatigueConfig?.refreshRateMs]);

  useEffect(() => {
    const controller = new AbortController();
    const loadConfig = async () => {
      try {
        const response = await fetch('/advanced-fatigue.config.json', { signal: controller.signal });
        if (!response.ok) return;
        const config = (await response.json()) as FatigueDashboardConfig;
        setFatigueConfig(config);
      } catch {
        setFatigueConfig(undefined);
      }
    };
    loadConfig();
    return () => {
      controller.abort();
    };
  }, []);

  const formatNum = (val: number | undefined | null, decimals: number = 2) => {
    if (val === undefined || val === null || isNaN(val) || !isFinite(val)) return 'N/A';
    return val.toFixed(decimals);
  };

  const generateReport = () => {
    if (!structural && !shmData) {
      alert('No structural data available to generate report.');
      return;
    }

    const safeVal = (val: unknown, fallback: string | number = 0) => {
      if (val === null || val === undefined) return fallback;
      if (typeof val === 'number') {
        return isNaN(val) || !isFinite(val) ? fallback : val;
      }
      return val;
    };

    const report = {
      timestamp: new Date().toISOString(),
      title: `${activeProfile?.name || 'Digital Twin'} — Structural Analysis Report`,
      platform: activeProfile?.name || 'OC4-DeepCwind Semi-submersible',
      assetType: activeProfile?.assetType || 'offshore_wind',
      physicsConfig,
      status: {
        connected: isConnected,
      },
      structuralAnalysis: {
        mooring: structural
          ? {
              standard: 'API RP 2SK / Stiffness Model',
              totalTension: structural.mooring.totalHorizontalForce,
              lines: structural.mooring.lines,
            }
          : 'N/A',
        tower: structural
          ? {
              standard: 'ISO 19901-3 / Beam FEA',
              maxStressMPa: structural.tower.maxStress,
              utilization: structural.tower.utilization,
              baseMoment: structural.tower.baseMoment,
            }
          : 'N/A',
        shm: {
          status: shmData ? shmData.status : 'Active',
          damageIndex: shmData
            ? safeVal(shmData.metrics.damage_index)
            : structural
              ? safeVal(structural.shm.damageIndex)
              : 0,
          fatigueLifeUsed: shmData
            ? safeVal(shmData.metrics.fatigue_life_used_percent)
            : structural
              ? safeVal(structural.shm.fatigueLifeUsed)
              : 0,
          rulYears: shmData
            ? safeVal(shmData.metrics.remaining_life_years, 25)
            : structural
              ? safeVal(structural.shm.rulYears, 25)
              : 25,
          activeAlerts: shmData ? shmData.anomalies : structural ? structural.shm.alerts : [],
        },
      },
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(activeProfile?.name || 'Twin').replace(/\s+/g, '_')}_SHM_Report_${new Date().getTime()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Integridad estructural"
        title={
          <span className="inline-flex items-center gap-2">
            {activeProfile && <Glyph name={activeProfile.icon} className="w-5 h-5 text-blue-600 dark:text-blue-400" />}
            <span>{activeProfile ? `${activeProfile.name} — SHM` : 'Structural Health Monitoring'}</span>
          </span>
        }
        description={`ID: ${shmData?.sensor_id || 'UNKNOWN'} · Escala 1:${physicsConfig.scaleFactor} · Acero Fy=${physicsConfig.yieldStrength} MPa · Última act.: ${shmData ? new Date(shmData.timestamp).toLocaleTimeString() : 'N/A'}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={showPhysicsPanel ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setShowPhysicsPanel(!showPhysicsPanel)}
            >
              <Sliders className="w-3.5 h-3.5" /> Parámetros físicos y cargas
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={resetStructuralDamage}
              title="Reiniciar acumulador de daño por fatiga"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Reset daño
            </Button>
            <Button variant="primary" size="sm" onClick={generateReport}>
              <FileText className="w-3.5 h-3.5" /> Exportar reporte
            </Button>
            <Link
              to="/map"
              className="px-3 py-1.5 border border-gray-300 dark:border-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 rounded-md inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Mapa
            </Link>
          </div>
        }
      />

      {/* Interactive Physics & Environmental Load Configurator */}
      {showPhysicsPanel && (
        <Card className="p-5 space-y-4">
          <CardHeader
            title="Ajuste en tiempo real del motor físico y cargas ambientales"
            subtitle="Sincronizado con StructuralEngine.ts y Python SHM Analyzer"
          />
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <div>
              <label className="ui-label">Viento (m/s)</label>
              <input
                type="number"
                step="0.5"
                value={envConditions.windSpeed}
                onChange={(e) => setEnvConditions({ windSpeed: Number(e.target.value) })}
                className="ui-input"
              />
            </div>
            <div>
              <label className="ui-label">Altura ola Hs (m)</label>
              <input
                type="number"
                step="0.2"
                value={envConditions.waveHeight}
                onChange={(e) => setEnvConditions({ waveHeight: Number(e.target.value) })}
                className="ui-input"
              />
            </div>
            <div>
              <label className="ui-label">Escala (λ)</label>
              <input
                type="number"
                value={physicsConfig.scaleFactor}
                onChange={(e) => updatePhysicsConfig({ scaleFactor: Number(e.target.value) })}
                className="ui-input"
              />
            </div>
            <div>
              <label className="ui-label">Fy acero (MPa)</label>
              <input
                type="number"
                value={physicsConfig.yieldStrength}
                onChange={(e) => updatePhysicsConfig({ yieldStrength: Number(e.target.value) })}
                className="ui-input"
              />
            </div>
            <div>
              <label className="ui-label">Altura torre (m)</label>
              <input
                type="number"
                step="0.05"
                value={physicsConfig.structureHeight}
                onChange={(e) => updatePhysicsConfig({ structureHeight: Number(e.target.value) })}
                className="ui-input"
              />
            </div>
            <div>
              <label className="ui-label">Nº líneas amarre</label>
              <input
                type="number"
                min={1}
                max={12}
                value={physicsConfig.numMooringLines}
                onChange={(e) => updatePhysicsConfig({ numMooringLines: Number(e.target.value) })}
                className="ui-input"
              />
            </div>
            <div>
              <label className="ui-label">Vida diseño (años)</label>
              <input
                type="number"
                value={physicsConfig.designLifeYears}
                onChange={(e) => updatePhysicsConfig({ designLifeYears: Number(e.target.value) })}
                className="ui-input"
              />
            </div>
          </div>
        </Card>
      )}

      {/* SHM Dashboard (Python Backend) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            Advanced Structural Health Monitoring
          </h3>
          <Badge variant="info">Python SHM Engine</Badge>
        </div>

        {shmData ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card
              className="p-4 cursor-pointer hover:border-blue-500/60 transition-colors group"
              onClick={async () => {
                const newDamage = prompt('Set Damage Index (0.0 - 1.0):', shmData.metrics.damage_index.toString());
                if (newDamage !== null) {
                  const parsed = parseFloat(newDamage);
                  if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
                    setShmData({
                      ...shmData,
                      metrics: {
                        ...shmData.metrics,
                        damage_index: parsed,
                      },
                    });

                    try {
                      await fetch(`http://${window.location.hostname}:8080/damage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ damage_index: parsed }),
                      });
                    } catch (e) {
                      console.error('Failed to update damage index', e);
                      alert('Failed to update damage index. Is the server running?');
                    }
                  } else {
                    alert('Please enter a valid number between 0 and 1');
                  }
                }
              }}
              title="Click to manually set Damage Index"
            >
              <p className="text-xs text-gray-500 font-medium mb-1 flex items-center justify-between">
                <span>Damage Index</span>
                <Edit2 className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-500 transition-colors" />
              </p>
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`text-2xl font-semibold font-mono tabular-nums ${
                    shmData.metrics.damage_index > 0.5 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {formatNum(shmData.metrics.damage_index, 4)}
                </span>
                <span className="text-xs text-gray-400">/ 1.0</span>
              </div>
              <p className="text-[11px] text-gray-400 mt-1">Miner&apos;s Rule (Cumulative)</p>
            </Card>

            <Card className="p-4">
              <p className="text-xs text-gray-500 font-medium mb-1">Rem. Life (RUL)</p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold font-mono tabular-nums text-gray-900 dark:text-white">
                  {formatNum(shmData.metrics.remaining_life_years, 1)}
                </span>
                <span className="text-xs text-gray-400">Years</span>
              </div>
              <p className="text-[11px] text-gray-400 mt-1">Weibull Probabilistic Model</p>
            </Card>

            <Card className="p-4">
              <p className="text-xs text-gray-500 font-medium mb-1">Current Stress</p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold font-mono tabular-nums text-gray-900 dark:text-white">
                  {formatNum(shmData.metrics.current_stress_mpa)}
                </span>
                <span className="text-xs text-gray-400">MPa</span>
              </div>
              <p className="text-[11px] text-gray-400 mt-1">Virtual Strain Gauge</p>
            </Card>

            <Card className="p-4">
              <p className="text-xs text-gray-500 font-medium mb-2">Status</p>
              <Badge
                variant={
                  shmData.status === 'HEALTHY'
                    ? 'success'
                    : shmData.status === 'WARNING'
                      ? 'warning'
                      : 'danger'
                }
              >
                {shmData.status}
              </Badge>
            </Card>
          </div>
        ) : (
          <Card className="p-6 text-center border-dashed">
            <Loader2 className="w-5 h-5 text-blue-600 animate-spin mx-auto mb-2" />
            <p className="text-gray-500 text-xs">Conectando con el motor Python SHM...</p>
          </Card>
        )}

        {/* Anomalies List */}
        {shmData && shmData.anomalies.length > 0 && (
          <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-xl">
            <h4 className="text-red-700 dark:text-red-400 font-semibold text-xs mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" /> Anomalías detectadas
            </h4>
            <ul className="list-disc list-inside text-xs text-red-600 dark:text-red-300 space-y-1">
              {shmData.anomalies.map((anomaly, i) => (
                <li key={i}>{anomaly}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Mooring & Telemetry in 2 columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-5 space-y-4">
          <CardHeader
            title="Líneas de amarre"
            subtitle="Estado de tensión y factor de seguridad"
            actions={<Anchor className="w-4 h-4 text-gray-400" />}
          />

          {structural ? (
            <div className="space-y-2">
              {structural.mooring.lines.map((line) => (
                <div
                  key={line.id}
                  className="bg-gray-50 dark:bg-slate-800/60 p-3 rounded-lg border border-gray-200 dark:border-slate-800 flex justify-between items-center"
                >
                  <div className="flex items-center gap-2">
                    <StatusDot
                      status={
                        line.safetyFactor > 2.0
                          ? 'online'
                          : line.safetyFactor > 1.67
                            ? 'warning'
                            : 'danger'
                      }
                    />
                    <span className="text-xs font-medium text-gray-900 dark:text-white">Línea #{line.id}</span>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-semibold font-mono tabular-nums text-gray-900 dark:text-white">
                      {line.tension.toFixed(1)} kN
                    </p>
                    <p className="text-[11px] font-mono text-gray-400">SF: {line.safetyFactor.toFixed(2)}</p>
                  </div>
                </div>
              ))}
              <div className="flex justify-between text-xs text-gray-500 pt-2 border-t border-gray-100 dark:border-slate-800">
                <span>Carga horizontal total</span>
                <span className="font-mono font-semibold text-gray-900 dark:text-white">
                  {(structural.mooring.totalHorizontalForce / 1000).toFixed(1)} kN
                </span>
              </div>
            </div>
          ) : (
            <div className="text-center text-xs text-gray-400 py-8">Esperando datos de análisis...</div>
          )}
        </Card>

        <Card className="p-5 lg:col-span-2 flex flex-col">
          <CardHeader
            title="Telemetría estructural (Stress & Tension)"
            subtitle="Tendencia temporal de tensión de amarre y esfuerzo en torre"
            actions={<TrendingUp className="w-4 h-4 text-gray-400" />}
          />
          <div className="h-64 flex-1">
            {shmData || structural ? (
              <StructuralTrendsChart data={structuralHistory} />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-xs">
                {isConnected ? 'Esperando datos...' : 'Desconectado del gemelo'}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Advanced Fatigue Dashboard */}
      <Suspense
        fallback={
          <Card className="h-64 flex items-center justify-center text-gray-400 text-xs">
            Cargando panel de fatiga...
          </Card>
        }
      >
        <AdvancedFatigueDashboard history={throttledHistory} config={fatigueConfig} />
      </Suspense>

      {/* Collapsible Client-Side Estimation Fallback */}
      <Card className="p-4">
        <button
          type="button"
          onClick={() => setShowLegacySection(!showLegacySection)}
          className="w-full flex items-center justify-between text-left text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
        >
          <span className="inline-flex items-center gap-2">
            <Activity className="w-3.5 h-3.5" />
            Estimación local en cliente (fallback OMA/Fatiga)
          </span>
          {showLegacySection ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>

        {showLegacySection && (
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-slate-800 space-y-4">
            {structural ? (
              <>
                {structural.shm.alerts.length > 0 && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                    {structural.shm.alerts.map((alertItem, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 text-red-700 dark:text-red-400 text-xs font-medium mb-1 last:mb-0"
                      >
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {alertItem}
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-gray-50 dark:bg-slate-800/60 p-3 rounded-lg border border-gray-200 dark:border-slate-800">
                    <div className="flex justify-between items-start mb-1">
                      <p className="text-xs text-gray-500">Damage Index</p>
                      {structural.shm.damageIndex > 0.4 ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                      ) : (
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                      )}
                    </div>
                    <p
                      className={`text-lg font-semibold font-mono ${
                        structural.shm.damageIndex > 0.4 ? 'text-amber-600' : 'text-emerald-600'
                      }`}
                    >
                      {(structural.shm.damageIndex * 100).toFixed(1)}%
                    </p>
                    <p className="text-[11px] text-gray-400">OMA Curvature</p>
                  </div>

                  <div className="bg-gray-50 dark:bg-slate-800/60 p-3 rounded-lg border border-gray-200 dark:border-slate-800">
                    <div className="flex justify-between items-start mb-1">
                      <p className="text-xs text-gray-500">Rem. Life</p>
                      <Clock className="w-3.5 h-3.5 text-blue-500" />
                    </div>
                    <p className="text-lg font-semibold font-mono text-gray-900 dark:text-white">
                      {structural.shm.rulYears.toFixed(1)} <span className="text-xs font-normal">yrs</span>
                    </p>
                    <p className="text-[11px] text-gray-400">Predicted (Fatigue)</p>
                  </div>

                  <div className="bg-gray-50 dark:bg-slate-800/60 p-3 rounded-lg border border-gray-200 dark:border-slate-800 flex flex-col justify-between">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-500">Fatigue Life Used</span>
                      <span className="font-mono font-semibold">{structural.shm.fatigueLifeUsed.toFixed(4)}%</span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-slate-700 rounded-full h-1.5">
                      <div
                        className="bg-blue-600 h-1.5 rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(100, structural.shm.fatigueLifeUsed)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center text-xs text-gray-400 py-4">Esperando datos de análisis...</div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

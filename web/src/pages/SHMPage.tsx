import { useEffect, useRef, useState, Suspense, lazy } from 'react';
import { Activity, AlertTriangle, CheckCircle, Clock, Anchor, TrendingUp, FileText, ArrowLeft, Edit2 } from 'lucide-react';
import { useTwinStore } from '../store/twinStore';
import type { SHMResponse } from '../types';
import type { FatigueDashboardConfig } from '../components/charts/AdvancedFatigueDashboard';
import StructuralTrendsChart from '../components/charts/StructuralTrendsChart';
import { Link } from 'react-router-dom';

const AdvancedFatigueDashboard = lazy(() => import('../components/charts/AdvancedFatigueDashboard'));

export default function SHMPage() {
    const { isConnected, structural, structuralHistory } = useTwinStore();
    const [shmData, setShmData] = useState<SHMResponse | null>(null);
    const [throttledHistory, setThrottledHistory] = useState(structuralHistory);
    const [fatigueConfig, setFatigueConfig] = useState<FatigueDashboardConfig | undefined>(undefined);
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

    // Safe formatting helper
    const formatNum = (val: number | undefined | null, decimals: number = 2) => {
        if (val === undefined || val === null || isNaN(val) || !isFinite(val)) return "N/A";
        return val.toFixed(decimals);
    };

    const generateReport = () => {
        if (!structural && !shmData) {
            alert("No structural data available to generate report.");
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
            title: "OC4 Structural Analysis Report",
            platform: "OC4-DeepCwind Semi-submersible",
            status: {
                connected: isConnected,
            },
            structuralAnalysis: {
                mooring: structural ? {
                    standard: "API RP 2SK",
                    totalTension: structural.mooring.totalHorizontalForce,
                    lines: structural.mooring.lines
                } : "N/A",
                tower: structural ? {
                    standard: "ISO 19901-3",
                    maxStressMPa: structural.tower.maxStress,
                    utilization: structural.tower.utilization,
                    baseMoment: structural.tower.baseMoment
                } : "N/A",
                shm: {
                    status: shmData ? shmData.status : "Active",
                    damageIndex: shmData ? safeVal(shmData.metrics.damage_index) : (structural ? safeVal(structural.shm.damageIndex) : 0),
                    fatigueLifeUsed: shmData ? safeVal(shmData.metrics.fatigue_life_used_percent) : (structural ? safeVal(structural.shm.fatigueLifeUsed) : 0),
                    rulYears: shmData ? safeVal(shmData.metrics.remaining_life_years, 25) : (structural ? safeVal(structural.shm.rulYears, 25) : 25),
                    activeAlerts: shmData ? shmData.anomalies : (structural ? structural.shm.alerts : [])
                }
            }
        };

        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `OC4_Structural_Report_${new Date().getTime()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="p-8 h-full overflow-y-auto bg-gray-50 dark:bg-slate-900">
            <div className="flex justify-between items-start mb-8 border-b pb-4 border-gray-100 dark:border-slate-800">
                <div>
                    <h2 className="text-3xl font-bold flex items-center gap-3 text-gray-900 dark:text-white">
                        <Activity className="w-8 h-8 text-blue-600" />
                        OC4 Structural Health Monitoring
                    </h2>
                    <p className="text-gray-500 mt-2 font-mono text-sm">
                        ID: {shmData?.sensor_id || 'UNKNOWN'} | Last Update: {shmData ? new Date(shmData.timestamp).toLocaleTimeString() : 'N/A'}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={generateReport}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 text-sm font-medium transition-colors"
                    >
                        <FileText className="w-4 h-4" /> Generate Report
                    </button>
                    <Link to="/map" className="px-4 py-2 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors">
                        <ArrowLeft className="w-4 h-4" /> Back to Map
                    </Link>
                </div>
            </div>

            {/* SHM Dashboard (Python Backend) */}
            <div className="mb-8">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
                        <Activity className="w-5 h-5 text-indigo-500" />
                        Advanced Structural Health Monitoring
                    </h3>
                    <span className="px-3 py-1 bg-indigo-100 text-indigo-800 rounded-full text-xs font-semibold border border-indigo-200">
                        Powered by Python SHM Engine
                    </span>
                </div>

                {shmData ? (
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                        <div
                            className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm cursor-pointer hover:border-blue-400 transition-colors group"
                            onClick={async () => {
                                const newDamage = prompt('Set Damage Index (0.0 - 1.0):', shmData.metrics.damage_index.toString());
                                if (newDamage !== null) {
                                    const parsed = parseFloat(newDamage);
                                    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
                                        // Speculatively update UI instantly for fluid feel
                                        setShmData({
                                            ...shmData,
                                            metrics: {
                                                ...shmData.metrics,
                                                damage_index: parsed
                                            }
                                        });

                                        try {
                                            await fetch(`http://${window.location.hostname}:8080/damage`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ damage_index: parsed })
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
                            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1 flex items-center justify-between">
                                Damage Index
                                <Edit2 className="w-3 h-3 text-gray-300 group-hover:text-blue-500 transition-colors" />
                            </p>
                            <div className="flex items-end gap-2">
                                <span className={`text-2xl font-bold ${shmData.metrics.damage_index > 0.5 ? 'text-red-500' : 'text-green-500'}`}>
                                    {formatNum(shmData.metrics.damage_index, 4)}
                                </span>
                                <span className="text-xs text-gray-400 mb-1">/ 1.0</span>
                            </div>
                            <p className="text-[10px] text-gray-400 mt-1">Miner's Rule (Cumulative)</p>
                        </div>

                        <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm">
                            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Rem. Life (RUL)</p>
                            <div className="flex items-end gap-2">
                                <span className="text-2xl font-bold text-blue-600">
                                    {formatNum(shmData.metrics.remaining_life_years, 1)}
                                </span>
                                <span className="text-xs text-gray-400 mb-1">Years</span>
                            </div>
                            <p className="text-[10px] text-gray-400 mt-1">Weibull Probabilistic Model</p>
                        </div>

                        <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm">
                            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Current Stress</p>
                            <div className="flex items-end gap-2">
                                <span className="text-2xl font-bold text-purple-600">
                                    {formatNum(shmData.metrics.current_stress_mpa)}
                                </span>
                                <span className="text-xs text-gray-400 mb-1">MPa</span>
                            </div>
                            <p className="text-[10px] text-gray-400 mt-1">Virtual Strain Gauge</p>
                        </div>

                        <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700 shadow-sm">
                            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Status</p>
                            <div className={`inline-flex items-center px-2 py-1 rounded text-sm font-bold ${shmData.status === 'HEALTHY' ? 'bg-green-100 text-green-700' :
                                shmData.status === 'WARNING' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'
                                }`}>
                                {shmData.status}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="p-8 text-center bg-gray-50 dark:bg-slate-800 rounded-xl border border-dashed border-gray-300">
                        <div className="animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-2"></div>
                        <p className="text-gray-500 text-sm">Connecting to Python SHM Backend...</p>
                    </div>
                )}

                {/* Anomalies List */}
                {shmData && shmData.anomalies.length > 0 && (
                    <div className="bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-4 rounded-r-lg mb-6">
                        <h4 className="text-red-700 dark:text-red-400 font-bold text-sm mb-2 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4" /> Detected Anomalies
                        </h4>
                        <ul className="list-disc list-inside text-sm text-red-600 dark:text-red-300 space-y-1">
                            {shmData.anomalies.map((anomaly, i) => (
                                <li key={i}>{anomaly}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>

            {/* Existing Client-Side Logic (Visual Fallback) */}
            <div className="mb-6 space-y-4 opacity-50 grayscale hover:grayscale-0 hover:opacity-100 transition-all">
                <h3 className="text-sm font-semibold text-gray-500 flex items-center gap-2">
                    <Activity className="w-4 h-4" /> Legacy Frontend Estimation
                </h3>


                {structural ? (
                    <>
                        {/* Alerts Section */}
                        {structural.shm.alerts.length > 0 && (
                            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                                {structural.shm.alerts.map((alert, idx) => (
                                    <div key={idx} className="flex items-center gap-2 text-red-700 dark:text-red-400 text-xs font-bold mb-1 last:mb-0">
                                        <AlertTriangle className="w-3 h-3" />
                                        {alert}
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            {/* Damage Index */}
                            <div className="bg-white dark:bg-slate-800 p-3 rounded-xl border border-gray-200 dark:border-slate-700">
                                <div className="flex justify-between items-start mb-1">
                                    <p className="text-xs text-gray-500">Damage Index</p>
                                    {structural.shm.damageIndex > 0.4 ? (
                                        <AlertTriangle className="w-4 h-4 text-orange-500" />
                                    ) : (
                                        <CheckCircle className="w-4 h-4 text-green-500" />
                                    )}
                                </div>
                                <p className={`text-lg font-bold ${structural.shm.damageIndex > 0.4 ? 'text-orange-600' : 'text-green-600'}`}>
                                    {(structural.shm.damageIndex * 100).toFixed(1)}%
                                </p>
                                <p className="text-[10px] text-gray-400">OMA Curvature</p>
                            </div>

                            {/* RUL */}
                            <div className="bg-white dark:bg-slate-800 p-3 rounded-xl border border-gray-200 dark:border-slate-700">
                                <div className="flex justify-between items-start mb-1">
                                    <p className="text-xs text-gray-500">Rem. Life</p>
                                    <Clock className="w-4 h-4 text-blue-500" />
                                </div>
                                <p className="text-lg font-bold text-gray-800 dark:text-white">
                                    {structural.shm.rulYears.toFixed(1)} <span className="text-xs font-normal">yrs</span>
                                </p>
                                <p className="text-[10px] text-gray-400">Predicted (Fatigue)</p>
                            </div>
                        </div>

                        {/* Fatigue Progress */}
                        <div className="bg-white dark:bg-slate-800 p-3 rounded-xl border border-gray-200 dark:border-slate-700">
                            <div className="flex justify-between text-xs mb-1">
                                <span className="text-gray-500">Fatigue Life Used</span>
                                <span className="font-bold">{structural.shm.fatigueLifeUsed.toFixed(4)}%</span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-2 dark:bg-gray-700">
                                <div
                                    className="bg-purple-600 h-2 rounded-full transition-all duration-500"
                                    style={{ width: `${Math.min(100, structural.shm.fatigueLifeUsed)}%` }}
                                ></div>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="text-center text-xs text-gray-400 py-4">Waiting for analysis data...</div>
                )}
            </div>

            {/* Mooring Lines Status */}
            <div className="mb-6 space-y-4">
                <h3 className="text-sm font-semibold text-gray-500 flex items-center gap-2">
                    <Anchor className="w-4 h-4" /> Mooring Lines Status
                </h3>

                {structural ? (
                    <div className="grid grid-cols-1 gap-2">
                        {structural.mooring.lines.map((line) => (
                            <div key={line.id} className="bg-white dark:bg-slate-800 p-3 rounded-lg border border-gray-200 dark:border-slate-700 flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${line.safetyFactor > 2.0 ? 'bg-green-500' : line.safetyFactor > 1.67 ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
                                    <span className="text-sm font-medium">Line #{line.id}</span>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm font-bold">{line.tension.toFixed(1)} kN</p>
                                    <p className="text-[10px] text-gray-400">SF: {line.safetyFactor.toFixed(2)}</p>
                                </div>
                            </div>
                        ))}
                        <div className="flex justify-between text-xs text-gray-500 mt-1 px-1">
                            <span>Total Horizontal Load:</span>
                            <span className="font-semibold text-gray-700 dark:text-gray-300">{(structural.mooring.totalHorizontalForce / 1000).toFixed(1)} kN</span>
                        </div>
                    </div>
                ) : (
                    <div className="text-center text-xs text-gray-400 py-4">Waiting for analysis data...</div>
                )}
            </div>

            {/* Charts */}
            <div className="space-y-4 flex-1 min-h-[300px]">
                <h3 className="text-sm font-semibold text-gray-500 flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Structural Response Trends</h3>

                <div className="h-64 bg-white dark:bg-slate-800 rounded-xl p-4 border border-gray-200 dark:border-slate-700 shadow-sm">
                    <p className="text-sm font-semibold mb-2 text-gray-600 dark:text-gray-300">Structural Telemetry (Stress & Tension)</p>
                    {shmData || structural ? (
                        <StructuralTrendsChart
                            data={structuralHistory}
                        />
                    ) : (
                        <div className="flex items-center justify-center h-full text-gray-400 text-xs">
                            {isConnected ? "Waiting for data..." : "Disconnected from Twin"}
                        </div>
                    )}
                </div>

                {/* Advanced Fatigue Dashboard */}
                <Suspense fallback={<div className="h-64 flex items-center justify-center text-gray-400">Loading Dashboard...</div>}>
                    <AdvancedFatigueDashboard history={throttledHistory} config={fatigueConfig} />
                </Suspense>
            </div>
        </div>
    );
}

import { Suspense, lazy, memo } from 'react';
import { Activity, Wind, X, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { POI, WeatherData } from '../../types';

// Lazy load heavy components
const Structure3DViewer = lazy(() => import('../structure/Structure3DViewer'));

interface SidePanelProps {
    activePoi: string | null;
    pois: POI[];
    weather: WeatherData | null;
    onClose: () => void;
}

const SidePanel = memo(({ activePoi, pois, weather, onClose }: SidePanelProps) => {
    
    if (!activePoi) return null;

    return (
        <div className={`absolute right-0 top-0 bottom-0 bg-white dark:bg-slate-900 shadow-2xl border-l border-gray-200 dark:border-slate-700 transition-transform duration-700 ease-[cubic-bezier(0.25,0.1,0.25,1)] z-[1100] translate-x-0 w-[60%] overflow-y-auto`}>
            <div className="p-8 flex flex-col h-full">
                <div className="flex justify-between items-start mb-8 border-b pb-4 border-gray-100 dark:border-slate-800">
                    <div>
                        <h2 className="text-3xl font-bold flex items-center gap-3 text-gray-900 dark:text-white">
                            <Activity className="w-8 h-8 text-blue-600" />
                            {pois.find(p => p.id === activePoi)?.title || 'Detail View'}
                        </h2>
                        <p className="text-gray-500 mt-2 font-mono text-sm">
                            Live Digital Twin View
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <Link 
                            to="/shm"
                            className="p-2 px-4 bg-blue-50 hover:bg-blue-100 dark:bg-slate-800 dark:hover:bg-slate-700 rounded-lg text-blue-600 flex items-center gap-2 text-sm font-medium transition-colors"
                        >
                            View Full SHM Analysis <ArrowRight className="w-4 h-4" />
                        </Link>
                        <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-full">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Weather Section */}
                {weather && (
                <div className="mb-6 bg-gray-50 dark:bg-slate-800 p-4 rounded-xl border border-gray-100 dark:border-slate-700">
                    <h3 className="text-sm font-semibold text-gray-500 mb-3 flex items-center gap-2"><Wind className="w-4 h-4" /> Meteo Conditions</h3>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <p className="text-xs text-gray-400">Wind</p>
                            <p className="font-semibold">{weather.windSpeed} km/h</p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-400">Waves</p>
                            <p className="font-semibold">{weather.waveHeight}m</p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-400">Temp</p>
                            <p className="font-semibold">{weather.temp}°C</p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-400">Visibility</p>
                            <p className="font-semibold">{weather.visibility / 1000} km</p>
                        </div>
                    </div>
                </div>
                )}

                {/* 3D Viewer */}
                <div className="mb-6 rounded-xl overflow-hidden border border-gray-200 dark:border-slate-700 min-h-[500px] flex-1 relative">
                    <div className="absolute top-2 left-2 z-10 bg-black/50 text-white px-2 py-1 rounded text-xs backdrop-blur-sm">
                        Live Twin
                    </div>
                    <Suspense fallback={<div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-slate-800">Loading 3D Viewer...</div>}>
                        <Structure3DViewer />
                    </Suspense>
                </div>
            </div>
        </div>
    );
});

export default SidePanel;

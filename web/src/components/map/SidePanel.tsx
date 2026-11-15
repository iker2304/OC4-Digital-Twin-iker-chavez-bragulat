import { Suspense, lazy, memo } from 'react';
import { Activity, Wind, X, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { POI, WeatherData } from '../../types';

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
    <div className="absolute right-0 top-0 bottom-0 bg-white dark:bg-slate-900 shadow-lg border-l border-gray-200 dark:border-slate-800 transition-transform duration-500 ease-out z-[1100] translate-x-0 w-[480px] overflow-y-auto">
      <div className="p-6 flex flex-col h-full">
        <div className="flex justify-between items-start mb-5 border-b pb-4 border-gray-100 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2 text-gray-900 dark:text-white">
              <Activity className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              {pois.find((p) => p.id === activePoi)?.title || 'Detail View'}
            </h2>
            <p className="text-gray-500 mt-1 font-mono text-xs">Vista en directo del gemelo digital</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/shm"
              className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 dark:bg-slate-800 dark:hover:bg-slate-700 rounded-md text-blue-600 dark:text-blue-400 flex items-center gap-1.5 text-xs font-medium transition-colors"
            >
              Análisis SHM <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-md"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Weather Section */}
        {weather && (
          <div className="mb-5 bg-gray-50 dark:bg-slate-800/60 p-4 rounded-xl border border-gray-200 dark:border-slate-800">
            <h3 className="text-xs font-semibold text-gray-500 mb-3 flex items-center gap-1.5">
              <Wind className="w-3.5 h-3.5" /> Condiciones meteorológicas
            </h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-[11px] text-gray-400">Viento</p>
                <p className="font-mono font-semibold text-gray-900 dark:text-white">{weather.windSpeed} km/h</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-400">Olas</p>
                <p className="font-mono font-semibold text-gray-900 dark:text-white">{weather.waveHeight} m</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-400">Temperatura</p>
                <p className="font-mono font-semibold text-gray-900 dark:text-white">{weather.temp} °C</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-400">Visibilidad</p>
                <p className="font-mono font-semibold text-gray-900 dark:text-white">{weather.visibility / 1000} km</p>
              </div>
            </div>
          </div>
        )}

        {/* 3D Viewer */}
        <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-slate-800 min-h-[420px] flex-1 relative">
          <div className="absolute top-2.5 left-2.5 z-10 bg-slate-900/80 text-white px-2 py-0.5 rounded text-[11px] font-medium backdrop-blur-sm border border-white/10">
            Live Twin
          </div>
          <Suspense
            fallback={
              <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-slate-800 text-xs text-gray-400">
                Cargando visor 3D...
              </div>
            }
          >
            <Structure3DViewer />
          </Suspense>
        </div>
      </div>
    </div>
  );
});

export default SidePanel;

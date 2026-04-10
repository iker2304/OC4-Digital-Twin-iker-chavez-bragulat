import { Activity, Bell, Box, CheckCircle, Cpu, LayoutDashboard, Signal, Wind, Waves, ShieldCheck, ArrowRight } from 'lucide-react';
import { useTwinStore } from '../store/twinStore';
import { Link } from 'react-router-dom';

export default function Home() {
  const { isConnected, structural, envConditions } = useTwinStore();

  const healthScore = structural ? (100 - (structural.shm.damageIndex * 100)).toFixed(1) : 'N/A';
  const isHealthy = structural ? structural.shm.damageIndex < 0.3 : true;

  const stats = [
    {
      label: 'Core Telemetry',
      value: isConnected ? 'Synchronized' : 'Disconnected',
      icon: Signal,
      color: isConnected ? 'text-emerald-500' : 'text-rose-500',
      bg: isConnected ? 'bg-emerald-100 dark:bg-emerald-500/10' : 'bg-rose-100 dark:bg-rose-500/10',
      border: isConnected ? 'border-emerald-200 dark:border-emerald-500/20' : 'border-rose-200 dark:border-rose-500/20'
    },
    {
      label: 'AI Computer Vision',
      value: 'Tracking Active',
      icon: Cpu,
      color: 'text-blue-500',
      bg: 'bg-blue-100 dark:bg-blue-500/10',
      border: 'border-blue-200 dark:border-blue-500/20'
    },
    {
      label: 'Structural Integrity',
      value: healthScore !== 'N/A' ? `${healthScore}%` : 'Pending',
      icon: ShieldCheck,
      color: isHealthy ? 'text-emerald-500' : 'text-amber-500',
      bg: isHealthy ? 'bg-emerald-100 dark:bg-emerald-500/10' : 'bg-amber-100 dark:bg-amber-500/10',
      border: isHealthy ? 'border-emerald-200 dark:border-emerald-500/20' : 'border-amber-200 dark:border-amber-500/20'
    },
    {
      label: 'Wave Height',
      value: envConditions?.waveHeight ? `${envConditions.waveHeight.toFixed(1)} m` : '2.1 m',
      icon: Waves,
      color: 'text-cyan-500',
      bg: 'bg-cyan-100 dark:bg-cyan-500/10',
      border: 'border-cyan-200 dark:border-cyan-500/20'
    },
  ];

  const quickLinks = [
    { title: 'Twin Monitor', icon: Box, path: '/twin', desc: 'Real-time 3D rigid-body kinematics visualization.', color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-500/10' },
    { title: 'Geo Map', icon: CheckCircle, path: '/map', desc: 'Live geospatial drift and meteorological conditions.', color: 'text-indigo-500', bg: 'bg-indigo-50 dark:bg-indigo-500/10' },
    { title: 'SHM Analysis', icon: Activity, path: '/shm', desc: 'Fatigue accumulation, S-N curves and RUL prediction.', color: 'text-purple-500', bg: 'bg-purple-50 dark:bg-purple-500/10' },
  ];

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">

      {/* Premium Hero Banner */}
      <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 to-blue-900 rounded-2xl p-8 md:p-12 shadow-xl border border-blue-800/50">
        <div className="absolute top-0 right-0 w-full h-full opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at right top, #60a5fa, transparent 50%)' }}></div>
        <div className="absolute -right-20 -bottom-20 opacity-20 transform rotate-12">
          <Wind className="w-96 h-96 text-white" />
        </div>

        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/20 border border-blue-400/30 text-blue-200 text-xs font-semibold uppercase tracking-wider mb-4">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></span>
            Operational Dashboard
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold text-white mb-4 tracking-tight">
            OC4 Digital Twin
          </h1>
          <p className="text-lg text-blue-100/80 mb-8 leading-relaxed">
            Advanced real-time simulation and structural health monitoring for offshore floating wind turbines. Unify computer vision tracking with physics-based lifecycle predictions.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link to="/twin" className="px-6 py-3 bg-blue-500 hover:bg-blue-400 text-white font-medium rounded-lg transition-colors flex items-center gap-2 shadow-lg shadow-blue-500/20">
              Launch 3D Monitor <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <div key={i} className={`bg-white dark:bg-slate-800 p-6 rounded-2xl border ${stat.border} shadow-sm transition-all hover:shadow-md hover:-translate-y-1`}>
            <div className="flex items-center gap-4 mb-3">
              <div className={`p-3 rounded-xl ${stat.bg}`}>
                <stat.icon className={`w-6 h-6 ${stat.color}`} />
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400 font-semibold uppercase tracking-wide">{stat.label}</p>
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-white pl-1">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Quick Actions */}
        <div className="lg:col-span-2">
          <h2 className="text-xl font-bold mb-6 text-gray-800 dark:text-white flex items-center gap-2">
            <LayoutDashboard className="w-5 h-5 text-gray-400" />
            Core Modules
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {quickLinks.map((link, i) => (
              <Link
                key={i}
                to={link.path}
                className="group p-6 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 hover:border-blue-500 dark:hover:border-blue-500 shadow-sm hover:shadow-xl transition-all flex flex-col items-start h-full"
              >
                <div className={`p-3 rounded-xl ${link.bg} mb-5 group-hover:scale-110 transition-transform`}>
                  <link.icon className={`w-7 h-7 ${link.color}`} />
                </div>
                <h3 className="font-bold text-lg text-gray-900 dark:text-white mb-2">{link.title}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors">{link.desc}</p>
              </Link>
            ))}
          </div>
        </div>

        {/* Notifications / System Log */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6 shadow-sm flex flex-col h-full">
          <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-100 dark:border-slate-700">
            <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <Bell className="w-5 h-5 text-gray-400" /> System Log
            </h2>
            <div className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
            </div>
          </div>

          <div className="space-y-6 flex-1 overflow-y-auto pr-2 custom-scrollbar">
            {isConnected ? (
              <div className="flex gap-4 items-start relative before:absolute before:left-[11px] before:top-8 before:bottom-[-24px] before:w-[2px] before:bg-gray-100 dark:before:bg-slate-700 last:before:hidden">
                <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center shrink-0 z-10 border-2 border-white dark:border-slate-800">
                  <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900 dark:text-white">MQTT Telemetry Secured</p>
                  <p className="text-xs text-gray-500 mt-1">Real-time data stream architecture is active.</p>
                </div>
              </div>
            ) : (
              <div className="flex gap-4 items-start">
                <div className="w-6 h-6 rounded-full bg-rose-100 dark:bg-rose-500/20 flex items-center justify-center shrink-0 z-10 border-2 border-white dark:border-slate-800">
                  <div className="w-2 h-2 rounded-full bg-rose-500"></div>
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900 dark:text-white">Awaiting Connection</p>
                  <p className="text-xs text-gray-500 mt-1">Establishing socket link with backend server...</p>
                </div>
              </div>
            )}

            <div className="flex gap-4 items-start relative before:absolute before:left-[11px] before:top-8 before:bottom-[-24px] before:w-[2px] before:bg-gray-100 dark:before:bg-slate-700 last:before:hidden">
              <div className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center shrink-0 z-10 border-2 border-white dark:border-slate-800">
                <ShieldCheck className="w-3 h-3 text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900 dark:text-white">SHM Engine Initialized</p>
                <p className="text-xs text-gray-500 mt-1">Fatigue algorithm ready. Base damage index set.</p>
              </div>
            </div>

            {structural?.shm.alerts.map((alert, i) => (
              <div key={i} className="flex gap-4 items-start relative before:absolute before:left-[11px] before:top-8 before:bottom-[-24px] before:w-[2px] before:bg-gray-100 dark:before:bg-slate-700 last:before:hidden">
                <div className="w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center shrink-0 z-10 border-2 border-white dark:border-slate-800">
                  <div className="w-2 h-2 rounded-full bg-amber-500"></div>
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900 dark:text-white">Fatigue Warning</p>
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{alert}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

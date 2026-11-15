import {
  Activity, Bell, Box, CheckCircle, Cpu, LayoutDashboard,
  Signal, Wind, Waves, ShieldCheck, ArrowRight, Brain, Database, Users, Radio
} from 'lucide-react';
import { useTwinStore } from '../store/twinStore';
import { useProfileStore } from '../store/profileStore';
import { Link } from 'react-router-dom';

export default function Home() {
  const { isConnected, isSimulating, toggleSimulation, structural, envConditions } = useTwinStore();
  const { profiles, activeProfileId, setActiveProfile } = useProfileStore();
  const activeProfile = profiles.find(p => p.id === activeProfileId) || profiles[0];

  const healthScore = structural ? (100 - (structural.shm.damageIndex * 100)).toFixed(1) : '99.9';
  const isHealthy = structural ? structural.shm.damageIndex < 0.3 : true;

  const stats = [
    {
      label: 'Telemetría & MQTT',
      value: isConnected ? (isSimulating ? 'Simulando 6-DOF' : 'Sincronizado') : 'En Espera',
      icon: Signal,
      color: isConnected ? 'text-emerald-500' : 'text-amber-500',
      bg: isConnected ? 'bg-emerald-100 dark:bg-emerald-500/10' : 'bg-amber-100 dark:bg-amber-500/10',
      border: isConnected ? 'border-emerald-200 dark:border-emerald-500/20' : 'border-amber-200 dark:border-amber-500/20'
    },
    {
      label: 'Visión IA (YOLO Pose)',
      value: `${activeProfile?.config.aiConfig?.numKeypoints || 11} Keypoints`,
      icon: Cpu,
      color: 'text-blue-500',
      bg: 'bg-blue-100 dark:bg-blue-500/10',
      border: 'border-blue-200 dark:border-blue-500/20'
    },
    {
      label: 'Integridad Estructural',
      value: `${healthScore}%`,
      icon: ShieldCheck,
      color: isHealthy ? 'text-emerald-500' : 'text-amber-500',
      bg: isHealthy ? 'bg-emerald-100 dark:bg-emerald-500/10' : 'bg-amber-100 dark:bg-amber-500/10',
      border: isHealthy ? 'border-emerald-200 dark:border-emerald-500/20' : 'border-amber-200 dark:border-amber-500/20'
    },
    {
      label: 'Entorno (Viento / Ola)',
      value: `${envConditions?.windSpeed?.toFixed(1) || 12} m/s · ${envConditions?.waveHeight?.toFixed(1) || 2.5} m`,
      icon: Waves,
      color: 'text-cyan-500',
      bg: 'bg-cyan-100 dark:bg-cyan-500/10',
      border: 'border-cyan-200 dark:border-cyan-500/20'
    },
  ];

  const quickLinks = [
    { title: 'Monitor 3D en Tiempo Real', icon: Box, path: '/twin', desc: 'Visualización cinemática 6-DOF, cámara MJPEG y selección de geometría 3D.', color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-500/10' },
    { title: 'Gemelos Digitales y Perfiles', icon: Users, path: '/profiles', desc: 'Crea y personaliza múltiples activos, parámetros físicos, modelos 3D y flujos Node-RED.', color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-500/10' },
    { title: 'Centro de Entrenamiento IA', icon: Brain, path: '/training', desc: 'Configura train.yaml, entrena modelos YOLO Pose/Detección y asígnalos a tus gemelos.', color: 'text-purple-500', bg: 'bg-purple-50 dark:bg-purple-500/10' },
    { title: 'Gestor de Datasets & Pose', icon: Database, path: '/dataset', desc: 'Genera datasets sintéticos con Blender, divide Train/Val y edita etiquetas YOLO.', color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10' },
    { title: 'Análisis Estructural SHM & FEM', icon: Activity, path: '/shm', desc: 'Acumulación de fatiga (Miner/Paris), curvas S-N, predicción RUL y solver FEM.', color: 'text-rose-500', bg: 'bg-rose-50 dark:bg-rose-500/10' },
    { title: 'Mapa Geoespacial y Deriva', icon: CheckCircle, path: '/map', desc: 'Seguimiento de posición GPS/deriva y condiciones meteorológicas en vivo.', color: 'text-indigo-500', bg: 'bg-indigo-50 dark:bg-indigo-500/10' },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      {/* Dynamic Hero Banner */}
      <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-900 to-blue-950 rounded-2xl p-8 md:p-10 shadow-xl border border-blue-800/50">
        <div className="absolute top-0 right-0 w-full h-full opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at right top, #60a5fa, transparent 50%)' }}></div>
        <div className="absolute -right-20 -bottom-20 opacity-15 transform rotate-12">
          <Wind className="w-96 h-96 text-white" />
        </div>

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/20 border border-blue-400/30 text-blue-200 text-xs font-semibold uppercase tracking-wider mb-4">
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></span>
              Plataforma Multi-Gemelo Digital Configurable
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold text-white mb-3 tracking-tight flex items-center gap-3">
              <span>{activeProfile?.icon || '🌊'}</span>
              <span>{activeProfile?.name || 'OC4 Digital Twin Platform'}</span>
            </h1>
            <p className="text-base text-blue-100/80 mb-6 leading-relaxed">
              {activeProfile?.description ||
                'Plataforma generalista de Gemelos Digitales con seguimiento óptico por Visión Artificial (YOLO Pose), simulación estructural SHM/FEM en tiempo real y entrenamiento IA integrado desde la web.'}
            </p>
            <div className="flex flex-wrap gap-3">
              <Link to="/twin" className="px-5 py-2.5 bg-blue-500 hover:bg-blue-400 text-white text-sm font-semibold rounded-xl transition-colors flex items-center gap-2 shadow-lg shadow-blue-500/20">
                Abrir Monitor 3D <ArrowRight className="w-4 h-4" />
              </Link>
              <Link to="/profiles" className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold rounded-xl border border-slate-700 transition-colors">
                Personalizar Gemelos ({profiles.length})
              </Link>
              <button
                onClick={() => toggleSimulation()}
                className={`px-5 py-2.5 text-sm font-semibold rounded-xl border transition-all flex items-center gap-2 ${
                  isSimulating
                    ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                    : 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30'
                }`}
              >
                <Radio className="w-4 h-4" />
                {isSimulating ? 'Detener Simulación 6-DOF' : 'Iniciar Simulación en Vivo'}
              </button>
            </div>
          </div>

          {/* Quick Twin Switcher Card */}
          <div className="bg-slate-950/70 backdrop-blur-md border border-slate-800 rounded-2xl p-4 min-w-[280px]">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2.5">
              Gemelos Digitales Disponibles
            </div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {profiles.map(p => (
                <button
                  key={p.id}
                  onClick={() => setActiveProfile(p.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-xs transition-all ${
                    p.id === activeProfile?.id
                      ? 'bg-blue-600/25 border border-blue-500/40 text-white font-semibold'
                      : 'bg-slate-900/60 hover:bg-slate-800 text-slate-300 border border-transparent'
                  }`}
                >
                  <span className="text-base">{p.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{p.name}</div>
                    <div className="text-[10px] text-slate-400 font-mono truncate">
                      {p.config.mqttTopic}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <div key={i} className={`bg-white dark:bg-slate-800 p-5 rounded-2xl border ${stat.border} shadow-sm transition-all hover:shadow-md`}>
            <div className="flex items-center gap-3 mb-2">
              <div className={`p-2.5 rounded-xl ${stat.bg}`}>
                <stat.icon className={`w-5 h-5 ${stat.color}`} />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 font-semibold uppercase tracking-wide">{stat.label}</p>
            </div>
            <p className="text-xl font-bold text-gray-900 dark:text-white pl-1">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Quick Actions */}
        <div className="lg:col-span-2">
          <h2 className="text-xl font-bold mb-5 text-gray-800 dark:text-white flex items-center gap-2">
            <LayoutDashboard className="w-5 h-5 text-gray-400" />
            Módulos de la Plataforma
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {quickLinks.map((link, i) => (
              <Link
                key={i}
                to={link.path}
                className="group p-5 bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 hover:border-blue-500 dark:hover:border-blue-500 shadow-sm hover:shadow-xl transition-all flex flex-col items-start h-full"
              >
                <div className={`p-3 rounded-xl ${link.bg} mb-4 group-hover:scale-110 transition-transform`}>
                  <link.icon className={`w-6 h-6 ${link.color}`} />
                </div>
                <h3 className="font-bold text-base text-gray-900 dark:text-white mb-1.5">{link.title}</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{link.desc}</p>
              </Link>
            ))}
          </div>
        </div>

        {/* Notifications / System Log */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6 shadow-sm flex flex-col h-full">
          <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-100 dark:border-slate-700">
            <h2 className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <Bell className="w-5 h-5 text-gray-400" /> Estado del Sistema
            </h2>
            <div className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
            </div>
          </div>

          <div className="space-y-5 flex-1 overflow-y-auto pr-2 custom-scrollbar">
            <div className="flex gap-3 items-start">
              <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center shrink-0">
                <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900 dark:text-white">
                  Gemelo Activo: {activeProfile?.name || 'OC4 Floating Turbine'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Tópico: {activeProfile?.config.mqttTopic || 'oc4/telemetry'} · Escala 1:{activeProfile?.config.physicsConfig?.scaleFactor || 100}
                </p>
              </div>
            </div>

            <div className="flex gap-3 items-start">
              <div className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900 dark:text-white">Motor Físico y SHM Listo</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Acero {activeProfile?.config.physicsConfig?.yieldStrength || 355} MPa · {activeProfile?.config.physicsConfig?.numMooringLines || 3} líneas de soporte.
                </p>
              </div>
            </div>

            {structural?.shm.alerts.map((alert, i) => (
              <div key={i} className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center shrink-0">
                  <div className="w-2 h-2 rounded-full bg-amber-500"></div>
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900 dark:text-white">Alerta Estructural</p>
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">{alert}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

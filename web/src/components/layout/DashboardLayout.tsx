import { useState, useEffect } from 'react';
import {
  LayoutDashboard, Activity, Settings, Database, Map, ChevronLeft, ChevronRight,
  Home, Users, LogOut, ChevronDown, Grid, Brain, Radio, Plus
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import cimneLogo from '../../assets/cimne-logo.png';
import { useAuthStore } from '../../store/authStore';
import { useProfileStore } from '../../store/profileStore';
import { useTwinStore } from '../../store/twinStore';

const navItems = [
  { icon: Home, label: 'Home', path: '/' },
  { icon: LayoutDashboard, label: 'Twin Monitor', path: '/twin' },
  { icon: Users, label: 'Gemelos Digitales', path: '/profiles' },
  { icon: Brain, label: 'Entrenamiento IA', path: '/training' },
  { icon: Database, label: 'Datasets & Pose', path: '/dataset' },
  { icon: Activity, label: 'Análisis SHM', path: '/shm' },
  { icon: Grid, label: 'Análisis FEM', path: '/fem' },
  { icon: Map, label: 'Mapa Geográfico', path: '/map' },
  { icon: Activity, label: 'Grafana', path: '/grafana' },
  { icon: Settings, label: 'Configuración', path: '/settings' },
];

export const DashboardLayout = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showTwinSelector, setShowTwinSelector] = useState(false);

  const { currentUser, logout } = useAuthStore();
  const { profiles, activeProfileId, loadProfiles, setActiveProfile } = useProfileStore();
  const { isSimulating, toggleSimulation, isConnected, connect } = useTwinStore();

  useEffect(() => {
    if (currentUser?.id) {
      loadProfiles(currentUser.id);
    }
  }, [currentUser?.id, loadProfiles]);

  useEffect(() => {
    if (!isConnected) {
      connect();
    }
  }, []);

  const activeProfile = profiles.find(p => p.id === activeProfileId) || profiles[0];

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-white">
      {/* Sidebar */}
      <aside
        className={clsx(
          'bg-white border-r border-gray-200 dark:bg-gray-800 dark:border-gray-700 flex flex-col transition-all duration-300 ease-in-out relative',
          isCollapsed ? 'w-20' : 'w-64'
        )}
      >
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="absolute -right-3 top-20 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full p-1 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 z-50"
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>

        <div className="p-6 flex items-center justify-center border-b border-gray-100 dark:border-gray-700 h-20">
          <img
            src={cimneLogo}
            alt="CIMNE Logo"
            className={clsx(
              'object-contain transition-all duration-300',
              isCollapsed ? 'h-8 w-auto' : 'h-11 w-auto'
            )}
          />
        </div>

        {/* Active Profile Indicator */}
        {!isCollapsed && activeProfile && (
          <div
            onClick={() => navigate('/profiles')}
            className="mx-3 mt-3 px-3 py-2.5 rounded-xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10 cursor-pointer hover:border-emerald-500/40 transition-all"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-lg">{activeProfile.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 truncate">
                  {activeProfile.name}
                </p>
                <p className="text-[10px] text-emerald-600/80 dark:text-emerald-400/80 flex items-center gap-1 truncate">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  MQTT: {activeProfile.config.mqttTopic}
                </p>
              </div>
            </div>
          </div>
        )}

        <nav className="mt-3 flex-1 px-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                title={isCollapsed ? item.label : ''}
                className={clsx(
                  'flex items-center px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                  isActive
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
                  isCollapsed && 'justify-center px-2'
                )}
              >
                <item.icon
                  className={clsx(
                    'w-5 h-5 transition-colors shrink-0',
                    isActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400',
                    !isCollapsed && 'mr-3'
                  )}
                />
                {!isCollapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* User Profile Section */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className={clsx(
              'flex items-center gap-3 w-full hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-xl p-2 transition-all',
              isCollapsed && 'justify-center'
            )}
          >
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0 shadow-sm"
              style={{ backgroundColor: '#3b82f6' }}
            >
              {currentUser?.full_name?.charAt(0).toUpperCase() ||
                currentUser?.username?.charAt(0).toUpperCase() ||
                'U'}
            </div>
            {!isCollapsed && (
              <div className="overflow-hidden flex-1 text-left">
                <p className="text-sm font-semibold truncate text-gray-900 dark:text-white">
                  {currentUser?.full_name || currentUser?.username || 'User'}
                </p>
                <p className="text-xs text-gray-400 truncate">@{currentUser?.username}</p>
              </div>
            )}
            {!isCollapsed && (
              <ChevronDown
                className={clsx('w-4 h-4 text-gray-400 transition-transform', showUserMenu && 'rotate-180')}
              />
            )}
          </button>

          {showUserMenu && (
            <div
              className={clsx(
                'absolute bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden z-50',
                isCollapsed ? 'left-full bottom-4 ml-2 w-48' : 'left-3 right-3 bottom-full mb-2'
              )}
            >
              <div className="p-3 border-b border-gray-100 dark:border-slate-700">
                <p className="text-sm font-bold text-gray-900 dark:text-white">
                  {currentUser?.full_name || currentUser?.username}
                </p>
                <p className="text-xs text-gray-400">{currentUser?.email}</p>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all"
              >
                <LogOut className="w-4 h-4" /> Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden w-full">
        <header className="bg-white border-b border-gray-200 h-16 flex items-center justify-between px-6 shadow-sm dark:bg-gray-800 dark:border-gray-700 shrink-0 z-30">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
              {navItems.find(i => i.path === location.pathname)?.label || 'Plataforma Digital Twin'}
            </h2>
          </div>

          <div className="flex items-center space-x-3">
            {/* Live Telemetry Simulation Button */}
            <button
              onClick={() => toggleSimulation()}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all',
                isSimulating
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm'
                  : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 border-gray-200 dark:border-slate-600 hover:bg-gray-200 dark:hover:bg-slate-600'
              )}
              title="Simular telemetría cinemática 6-DOF, fuerzas de amarre y fatiga SHM para el Gemelo Digital activo"
            >
              <Radio className={clsx('w-3.5 h-3.5', isSimulating && 'animate-spin text-amber-400')} />
              <span>{isSimulating ? 'Simulación 6-DOF: ACTIVA' : 'Simular Telemetría'}</span>
            </button>

            {/* Global Digital Twin Switcher Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowTwinSelector(!showTwinSelector)}
                className="flex items-center gap-2 px-3.5 py-1.5 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-full text-xs hover:border-emerald-500 transition-all"
              >
                <span>{activeProfile?.icon || '🌊'}</span>
                <span className="font-semibold text-emerald-700 dark:text-emerald-400 max-w-[180px] truncate">
                  {activeProfile?.name || 'Seleccionar Gemelo'}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-emerald-500" />
              </button>

              {showTwinSelector && (
                <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-2xl p-2 z-50">
                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Cambiar Gemelo Digital Activo
                  </div>
                  <div className="max-h-60 overflow-y-auto space-y-1">
                    {profiles.map(p => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setActiveProfile(p.id);
                          setShowTwinSelector(false);
                        }}
                        className={clsx(
                          'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-xs transition-colors',
                          p.id === activeProfile?.id
                            ? 'bg-emerald-500/15 text-emerald-400 font-semibold border border-emerald-500/30'
                            : 'text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800'
                        )}
                      >
                        <span className="text-base">{p.icon}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{p.name}</div>
                          <div className="text-[10px] text-slate-500 font-mono truncate">
                            {p.config.mqttTopic} · {p.config.model3dUrl?.replace('/models/', '')}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="pt-2 mt-2 border-t border-gray-100 dark:border-slate-800">
                    <button
                      onClick={() => {
                        setShowTwinSelector(false);
                        navigate('/profiles');
                      }}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
                    >
                      <Plus className="w-3.5 h-3.5" /> Gestionar / Crear Gemelos Digitales
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 px-3 py-1 bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400 rounded-full text-xs font-medium border border-green-100 dark:border-green-500/20">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
              Online
            </div>
          </div>
        </header>
        <div className="flex-1 min-w-0 overflow-auto p-6 relative">
          {children}
        </div>
      </main>
    </div>
  );
};

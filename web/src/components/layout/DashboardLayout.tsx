import { useState, useEffect, useRef } from 'react';
import {
  LayoutDashboard, Activity, Settings, Database, Map, Home, Users, LogOut, ChevronsUpDown, Brain, Plus,
  Boxes, LineChart, PanelLeftClose, PanelLeftOpen, Moon, Sun, Check, Radio, type LucideIcon,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import cimneLogo from '../../assets/cimne-logo.png';
import { useAuthStore } from '../../store/authStore';
import { useProfileStore } from '../../store/profileStore';
import { useTwinStore } from '../../store/twinStore';
import { Glyph } from '../ui/Glyph';
import { StatusDot } from '../ui';
import { useTheme } from '../../lib/theme';

interface NavItem {
  icon: LucideIcon;
  label: string;
  path: string;
}

const navGroups: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { icon: Home, label: 'Inicio', path: '/' },
      { icon: LayoutDashboard, label: 'Monitor', path: '/twin' },
      { icon: Users, label: 'Gemelos digitales', path: '/profiles' },
    ],
  },
  {
    label: 'IA y datos',
    items: [
      { icon: Brain, label: 'Entrenamiento', path: '/training' },
      { icon: Database, label: 'Datasets y pose', path: '/dataset' },
    ],
  },
  {
    label: 'Análisis',
    items: [
      { icon: Activity, label: 'SHM', path: '/shm' },
      { icon: Boxes, label: 'FEM', path: '/fem' },
      { icon: Map, label: 'Mapa', path: '/map' },
      { icon: LineChart, label: 'Grafana', path: '/grafana' },
    ],
  },
];

const footerNav: NavItem[] = [{ icon: Settings, label: 'Configuración', path: '/settings' }];

const allNavItems = [...navGroups.flatMap(g => g.items), ...footerNav];

const isPathActive = (current: string, path: string) =>
  path === '/' ? current === '/' : current === path || current.startsWith(`${path}/`);

/** Closes a popover when clicking outside of it. */
function useClickOutside(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);
  return ref;
}

export const DashboardLayout = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showTwinSelector, setShowTwinSelector] = useState(false);

  const { currentUser, logout } = useAuthStore();
  const { profiles, activeProfileId, loadProfiles, setActiveProfile } = useProfileStore();
  const { isSimulating, toggleSimulation, isConnected, connect } = useTwinStore();
  const { theme, toggleTheme } = useTheme();

  const userMenuRef = useClickOutside(showUserMenu, () => setShowUserMenu(false));
  const twinMenuRef = useClickOutside(showTwinSelector, () => setShowTwinSelector(false));

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
  const currentPage = allNavItems.find(i => isPathActive(location.pathname, i.path));
  const userInitial =
    currentUser?.full_name?.charAt(0).toUpperCase() || currentUser?.username?.charAt(0).toUpperCase() || 'U';

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const renderNavLink = (item: NavItem) => {
    const isActive = isPathActive(location.pathname, item.path);
    return (
      <Link
        key={item.path}
        to={item.path}
        title={isCollapsed ? item.label : undefined}
        className={clsx(
          'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors',
          isActive
            ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800/80 dark:text-zinc-50'
            : 'text-zinc-600 hover:bg-zinc-100/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100',
          isCollapsed && 'justify-center px-0'
        )}
      >
        <item.icon
          className={clsx(
            'h-4 w-4 shrink-0',
            isActive ? 'text-zinc-900 dark:text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300'
          )}
          strokeWidth={1.75}
        />
        {!isCollapsed && <span className="truncate">{item.label}</span>}
      </Link>
    );
  };

  return (
    <div className="flex h-screen bg-zinc-50 text-zinc-900 dark:bg-[#0c0c0e] dark:text-zinc-100">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside
        className={clsx(
          'relative flex shrink-0 flex-col border-r border-zinc-200 bg-white transition-[width] duration-200 dark:border-zinc-800/80 dark:bg-zinc-950',
          isCollapsed ? 'w-16' : 'w-60'
        )}
      >
        {/* Brand */}
        <div className={clsx('flex h-14 items-center', isCollapsed ? 'justify-center' : 'px-4')}>
          <img
            src={cimneLogo}
            alt="CIMNE"
            className={clsx(
              'w-auto object-contain dark:brightness-0 dark:invert',
              isCollapsed ? 'h-3.5' : 'h-[18px]'
            )}
          />
          {!isCollapsed && (
            <span className="ml-2.5 border-l border-zinc-200 pl-2.5 text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              Digital Twin
            </span>
          )}
        </div>

        {/* Active twin switcher */}
        <div ref={twinMenuRef} className={clsx('relative pb-2', isCollapsed ? 'px-2' : 'px-3')}>
          <button
            onClick={() => setShowTwinSelector(!showTwinSelector)}
            title={isCollapsed ? activeProfile?.name : undefined}
            className={clsx(
              'flex w-full items-center gap-2.5 rounded-lg border border-zinc-200 bg-white p-1.5 text-left transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/70',
              isCollapsed && 'justify-center border-transparent bg-transparent dark:bg-transparent'
            )}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
              <Glyph name={activeProfile?.icon} size={15} />
            </span>
            {!isCollapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                    {activeProfile?.name || 'Seleccionar gemelo'}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-zinc-500">
                    {activeProfile?.config.mqttTopic || 'Sin tópico'}
                  </span>
                </span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              </>
            )}
          </button>

          {showTwinSelector && (
            <div
              className={clsx(
                'absolute z-50 mt-1 w-72 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900',
                isCollapsed ? 'left-full top-0 ml-2' : 'left-3'
              )}
            >
              <div className="px-2 pb-1 pt-1.5 ui-eyebrow">Gemelos digitales</div>
              <div className="max-h-64 overflow-y-auto">
                {profiles.map(p => {
                  const selected = p.id === activeProfile?.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => {
                        setActiveProfile(p.id);
                        setShowTwinSelector(false);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
                        <Glyph name={p.icon} size={13} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-zinc-900 dark:text-zinc-100">{p.name}</span>
                        <span className="block truncate font-mono text-[10px] text-zinc-500">
                          {p.config.mqttTopic} · {p.config.model3dUrl?.replace('/models/', '')}
                        </span>
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0 text-zinc-900 dark:text-zinc-100" />}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1 border-t border-zinc-100 pt-1 dark:border-zinc-800">
                <button
                  onClick={() => {
                    setShowTwinSelector(false);
                    navigate('/profiles');
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  <Plus className="h-4 w-4" /> Gestionar gemelos
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className={clsx('flex-1 space-y-5 overflow-y-auto py-3', isCollapsed ? 'px-2' : 'px-3')}>
          {navGroups.map((group, gi) => (
            <div key={gi} className="space-y-0.5">
              {group.label && !isCollapsed && <div className="px-2.5 pb-1.5 ui-eyebrow">{group.label}</div>}
              {group.label && isCollapsed && <div className="mx-auto mb-2 h-px w-6 bg-zinc-200 dark:bg-zinc-800" />}
              {group.items.map(renderNavLink)}
            </div>
          ))}
        </nav>

        {/* Footer: settings + user */}
        <div className={clsx('space-y-0.5 border-t border-zinc-200 py-3 dark:border-zinc-800/80', isCollapsed ? 'px-2' : 'px-3')}>
          {footerNav.map(renderNavLink)}

          <div ref={userMenuRef} className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
                isCollapsed && 'justify-center'
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                {userInitial}
              </span>
              {!isCollapsed && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                    {currentUser?.full_name || currentUser?.username || 'Usuario'}
                  </span>
                </span>
              )}
              {!isCollapsed && <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />}
            </button>

            {showUserMenu && (
              <div
                className={clsx(
                  'absolute z-50 w-56 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900',
                  isCollapsed ? 'bottom-0 left-full ml-2' : 'bottom-full left-0 mb-1'
                )}
              >
                <div className="px-2 py-2">
                  <p className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                    {currentUser?.full_name || currentUser?.username}
                  </p>
                  <p className="truncate text-xs text-zinc-500">{currentUser?.email || `@${currentUser?.username}`}</p>
                </div>
                <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
                <button
                  onClick={toggleTheme}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                  {theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
                </button>
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                >
                  <LogOut className="h-4 w-4" /> Cerrar sesión
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────── */}
      <main className="flex w-full min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-30 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-950/80">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              title={isCollapsed ? 'Expandir menú' : 'Contraer menú'}
            >
              {isCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
            <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />
            <nav className="flex min-w-0 items-center gap-1.5 text-[13px]">
              <span className="truncate text-zinc-500">{activeProfile?.name || 'Plataforma'}</span>
              <span className="text-zinc-300 dark:text-zinc-700">/</span>
              <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                {currentPage?.label || 'Digital Twin'}
              </span>
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => toggleSimulation()}
              title="Simular telemetría cinemática 6-DOF, fuerzas de amarre y fatiga SHM para el gemelo activo"
              className={clsx(
                'inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors',
                isSimulating
                  ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-400'
                  : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
              )}
            >
              {isSimulating ? <StatusDot tone="warning" pulse /> : <Radio className="h-3.5 w-3.5" strokeWidth={1.75} />}
              <span className="hidden sm:inline">{isSimulating ? 'Simulación activa' : 'Simular telemetría'}</span>
            </button>

            <div
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
              title={isConnected ? 'Conectado al servidor de telemetría' : 'Sin conexión con el servidor de telemetría'}
            >
              <StatusDot tone={isConnected ? 'success' : 'neutral'} />
              <span className="hidden sm:inline">{isConnected ? 'Conectado' : 'Desconectado'}</span>
            </div>
          </div>
        </header>

        <div className="relative min-w-0 flex-1 overflow-auto p-6 lg:p-8">{children}</div>
      </main>
    </div>
  );
};

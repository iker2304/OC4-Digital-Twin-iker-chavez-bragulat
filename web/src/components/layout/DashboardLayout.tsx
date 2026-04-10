import { useState } from 'react';
import { LayoutDashboard, Activity, Settings, Database, Map, ChevronLeft, ChevronRight, Home, Users, LogOut, ChevronDown } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import cimneLogo from '../../assets/cimne-logo.png';
import { useAuthStore } from '../../store/authStore';
import { useProfileStore } from '../../store/profileStore';

const navItems = [
  { icon: Home, label: 'Home', path: '/' },
  { icon: LayoutDashboard, label: 'Twin Monitor', path: '/twin' },
  { icon: Map, label: 'Geo Map (Alpha)', path: '/map' },
  { icon: Activity, label: 'SHM Analysis (Alpha)', path: '/shm' },
  { icon: Users, label: 'DT Profiles', path: '/profiles' },
  { icon: Database, label: 'Dataset', path: '/dataset' },
  { icon: Activity, label: 'Grafana', path: '/grafana' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export const DashboardLayout = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const { currentUser, logout } = useAuthStore();
  const { profiles, activeProfileId } = useProfileStore();
  const activeProfile = profiles.find(p => p.id === activeProfileId);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-white">
      {/* Sidebar */}
      <aside
        className={clsx(
          "bg-white border-r border-gray-200 dark:bg-gray-800 dark:border-gray-700 flex flex-col transition-all duration-300 ease-in-out relative",
          isCollapsed ? "w-20" : "w-64"
        )}
      >
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="absolute -right-3 top-20 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full p-1 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 z-50"
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>

        <div className="p-6 flex items-center justify-center border-b border-gray-100 dark:border-gray-700 h-24">
          <img
            src={cimneLogo}
            alt="CIMNE Logo"
            className={clsx(
              "object-contain transition-all duration-300",
              isCollapsed ? "h-8 w-auto" : "h-12 w-auto"
            )}
          />
        </div>

        {/* Active Profile Indicator */}
        {!isCollapsed && activeProfile && (
          <div className="mx-3 mt-4 px-3 py-2 rounded-xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10">
            <div className="flex items-center gap-2">
              <span className="text-base">{activeProfile.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 truncate">{activeProfile.name}</p>
                <p className="text-[10px] text-emerald-500 dark:text-emerald-500/80 flex items-center gap-1">
                  <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                  Active Profile
                </p>
              </div>
            </div>
          </div>
        )}

        <nav className="mt-4 flex-1 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                title={isCollapsed ? item.label : ''}
                className={clsx(
                  "flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400"
                    : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800",
                  isCollapsed && "justify-center px-2"
                )}
              >
                <item.icon
                  className={clsx(
                    "w-5 h-5 transition-colors",
                    isActive ? "text-blue-600 dark:text-blue-400" : "text-gray-400",
                    !isCollapsed && "mr-3"
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
            className={clsx("flex items-center gap-3 w-full hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-xl p-2 transition-all", isCollapsed && "justify-center")}
          >
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0 shadow-sm"
              style={{ backgroundColor: '#3b82f6' }}
            >
              {currentUser?.full_name?.charAt(0).toUpperCase() || currentUser?.username?.charAt(0).toUpperCase() || 'U'}
            </div>
            {!isCollapsed && (
              <div className="overflow-hidden flex-1 text-left">
                <p className="text-sm font-semibold truncate text-gray-900 dark:text-white">{currentUser?.full_name || currentUser?.username || 'User'}</p>
                <p className="text-xs text-gray-400 truncate">@{currentUser?.username}</p>
              </div>
            )}
            {!isCollapsed && (
              <ChevronDown className={clsx("w-4 h-4 text-gray-400 transition-transform", showUserMenu && "rotate-180")} />
            )}
          </button>

          {showUserMenu && (
            <div className={clsx(
              "absolute bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden z-50",
              isCollapsed ? "left-full bottom-4 ml-2 w-48" : "left-3 right-3 bottom-full mb-2"
            )}>
              <div className="p-3 border-b border-gray-100 dark:border-slate-700">
                <p className="text-sm font-bold text-gray-900 dark:text-white">{currentUser?.full_name || currentUser?.username}</p>
                <p className="text-xs text-gray-400">{currentUser?.email}</p>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all"
              >
                <LogOut className="w-4 h-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden w-full">
        <header className="bg-white border-b border-gray-200 h-16 flex items-center justify-between px-6 shadow-sm dark:bg-gray-800 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
              {navItems.find(i => i.path === location.pathname)?.label || 'Dashboard'}
            </h2>
          </div>
          <div className="flex items-center space-x-4">
            {activeProfile && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-500/10 rounded-full text-xs">
                <span>{activeProfile.icon}</span>
                <span className="font-medium text-emerald-700 dark:text-emerald-400">{activeProfile.name}</span>
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-medium border border-green-100">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
              System Online
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

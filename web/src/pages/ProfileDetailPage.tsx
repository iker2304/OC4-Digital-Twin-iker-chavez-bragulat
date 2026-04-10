// @ts-nocheck - react-grid-layout types have breaking structural issues
import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ArrowLeft, GitBranch, LayoutDashboard,
  Radio, Clock, Cpu, Activity, Layers, Globe,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useProfileStore } from '../store/profileStore';
import { useNodeEditorStore } from '../store/nodeEditorStore';
import { useDashboardStore } from '../store/dashboardStore';
import NodeEditor from '../components/node-editor/NodeEditor';
import DashboardBuilder from '../components/dashboard-builder/DashboardBuilder';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import WidgetRenderer from '../components/dashboard-builder/widgets/WidgetRenderer';

type Tab = 'overview' | 'dashboard' | 'node-editor';

export default function ProfileDetailPage() {
  const { profileId } = useParams<{ profileId: string }>();
  const navigate = useNavigate();
  const { currentUser } = useAuthStore();
  const { profiles, setActiveProfile } = useProfileStore();
  const { loadFlows, flows } = useNodeEditorStore();
  const { loadDashboards, dashboards, startStreamPolling } = useDashboardStore();

  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const profile = profiles.find(p => p.id === profileId);

  useEffect(() => {
    if (!profileId || !currentUser) return;
    setActiveProfile(profileId);
    loadFlows(currentUser.id, profileId);
    loadDashboards(currentUser.id, profileId);
    startStreamPolling();
  }, [profileId, currentUser]);

  if (!profile) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-5xl mb-4">🔍</p>
          <h2 className="text-xl font-bold text-gray-700 dark:text-gray-300 mb-2">Profile not found</h2>
          <Link
            to="/profiles"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-400 text-white text-sm font-semibold rounded-xl transition-all"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Profiles
          </Link>
        </div>
      </div>
    );
  }

  const deployedFlows = (flows || []).filter(f => f?.deployed).length;
  const publishedDashboards = (dashboards || []).filter(d => d?.published).length;

  return (
    <div className="flex flex-col h-full -m-6 -mt-0 overflow-hidden">
      {/* ── Profile Header ── */}
      <div
        className="shrink-0 px-6 pt-4 pb-0 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700"
      >
        {/* Breadcrumb & actions */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/profiles')}
              className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-slate-700 transition-all text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <nav className="flex items-center gap-2 text-sm text-gray-400">
              <Link to="/profiles" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                Profiles
              </Link>
              <span>/</span>
              <span className="text-gray-700 dark:text-gray-200 font-semibold">{profile.name}</span>
            </nav>
          </div>

          {/* Profile stats strip */}
          <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
            <div className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-blue-500" />
              <span><strong className="text-gray-700 dark:text-gray-300">{flows.length}</strong> flows</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-emerald-500" />
              <span><strong className="text-gray-700 dark:text-gray-300">{deployedFlows}</strong> deployed</span>
            </div>
            <div className="flex items-center gap-1.5">
              <LayoutDashboard className="w-3.5 h-3.5 text-purple-500" />
              <span><strong className="text-gray-700 dark:text-gray-300">{dashboards.length}</strong> dashboards</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-pink-500" />
              <span><strong className="text-gray-700 dark:text-gray-300">{publishedDashboards}</strong> published</span>
            </div>
          </div>
        </div>

        {/* Profile identity row */}
        <div className="flex items-center gap-4 mb-4">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shadow-sm shrink-0"
            style={{
              background: `${profile.color}15`,
              border: `2px solid ${profile.color}30`,
            }}
          >
            {profile.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-extrabold text-gray-900 dark:text-white truncate">{profile.name}</h1>
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
                style={{ background: `${profile.color}15`, color: profile.color }}
              >
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: profile.color }} />
                Active
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400">
              <span className="flex items-center gap-1">
                <Radio className="w-3 h-3" />
                {profile.config.mqttBroker}:{profile.config.mqttPort}
              </span>
              <span className="flex items-center gap-1">
                <Cpu className="w-3 h-3" />
                {profile.config.mqttTopic}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Updated {new Date(profile.updatedAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="flex items-center gap-0.5">
          <TabButton
            id="tab-overview"
            active={activeTab === 'overview'}
            onClick={() => setActiveTab('overview')}
            icon={<Activity className="w-4 h-4" />}
            label="Overview"
            color="#10b981"
          />
          <TabButton
            id="tab-dashboard"
            active={activeTab === 'dashboard'}
            onClick={() => setActiveTab('dashboard')}
            icon={<LayoutDashboard className="w-4 h-4" />}
            label="Dashboard Builder"
            badge={dashboards.length > 0 ? dashboards.length : undefined}
            color="#a855f7"
          />
          <TabButton
            id="tab-node-editor"
            active={activeTab === 'node-editor'}
            onClick={() => setActiveTab('node-editor')}
            icon={<GitBranch className="w-4 h-4" />}
            label="Node Editor"
            badge={flows.length > 0 ? flows.length : undefined}
            color="#3b82f6"
          />
        </div>
      </div>

      {/* ── Tab Content ── */}
      <div className="flex-1 overflow-hidden relative" style={{ background: 'var(--app-bg)' }}>
        {activeTab === 'overview' && (
          <OverviewTab 
            profile={profile} 
            dashboards={dashboards} 
            onGoToBuilder={() => setActiveTab('dashboard')} 
          />
        )}
        {activeTab === 'dashboard' && (
          <DashboardBuilder userId={currentUser!.id} profileId={profile.id} />
        )}
        {activeTab === 'node-editor' && (
          <ReactFlowProvider>
            <NodeEditor userId={currentUser!.id} profileId={profile.id} />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}

// ── Overview Tab Component ──
function OverviewTab({ profile, dashboards, onGoToBuilder }: any) {
  const defaultDb = profile.defaultDashboardId && dashboards
    ? dashboards.find((d: any) => d.id === profile.defaultDashboardId) 
    : null;

  if (!defaultDb) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center max-w-md bg-white dark:bg-slate-800 p-8 rounded-3xl border border-gray-200 dark:border-slate-700 shadow-sm">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center">
            <LayoutDashboard className="w-10 h-10 text-emerald-500" />
          </div>
          <h3 className="text-xl font-black text-gray-900 dark:text-white mb-2">No Overview Pinned</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            Keep your digital twin's state front and center. Go to the Dashboard Builder, open a dashboard, and click the "Pin" icon so it appears here automatically.
          </p>
          <button
            onClick={onGoToBuilder}
            className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-bold rounded-xl shadow-lg shadow-emerald-500/20 transition-all"
          >
            Go to Dashboard Builder
          </button>
        </div>
      </div>
    );
  }

  // Check if grid layout actually has anything
  if (!defaultDb.layout || defaultDb.layout.length === 0) {
     return (
        <div className="h-full flex items-center justify-center text-gray-400">
           The pinned dashboard looks empty.
        </div>
     );
  }

  return (
    <div className="h-full overflow-auto p-4 custom-scrollbar">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-black text-gray-900 dark:text-white flex items-center gap-2">
                {defaultDb.name} <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 text-[10px] uppercase font-bold tracking-widest">Live Overview</span>
              </h2>
              <p className="text-sm text-gray-500 mt-1">{defaultDb.description}</p>
            </div>
        </div>
        
        <GridLayout
          className="layout"
          layout={defaultDb.layout}
          cols={12}
          rowHeight={80}
          width={1100} // A reasonably fixed width for overview mode or responsive
          isDraggable={false}
          isResizable={false}
          margin={[16, 16]}
          containerPadding={[0, 0]}
        >
          {defaultDb.widgets.map((widget: any) => (
            <div
              key={widget.id}
              className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-100 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-50 dark:border-slate-700/50 shrink-0 bg-gray-50/50 dark:bg-slate-900/50">
                <p className="text-xs font-bold text-gray-700 dark:text-gray-300 truncate">{widget.title}</p>
                {widget.streamId && (
                  <span className="flex items-center gap-1 text-[9px] text-emerald-500 font-bold uppercase tracking-wider shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live Target
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0 relative">
                <WidgetRenderer widget={widget} />
              </div>
            </div>
          ))}
        </GridLayout>
      </div>
    </div>
  );
}

// ── Tab button sub-component ──
function TabButton({
  id, active, onClick, icon, label, badge, color,
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  color: string;
}) {
  return (
    <button
      id={id}
      onClick={onClick}
      className={`relative flex items-center gap-2 px-4 py-3 text-sm font-semibold transition-all rounded-t-xl border-b-2 ${
        active
          ? 'text-gray-900 dark:text-white border-current'
          : 'text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700/50'
      }`}
      style={active ? { color, borderColor: color } : {}}
    >
      <span className={active ? '' : 'opacity-60'}>{icon}</span>
      {label}
      {badge !== undefined && (
        <span
          className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold text-white"
          style={{ background: active ? color : '#94a3b8' }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

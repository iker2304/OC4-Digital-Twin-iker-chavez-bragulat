// @ts-nocheck - react-grid-layout types have breaking structural issues
import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ArrowLeft, GitBranch, LayoutDashboard,
  Radio, Clock, Cpu, Activity, Layers, Globe, Sliders, Save, CheckCircle2, Upload
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
import { API_BASE_URL } from '../config/api';

type Tab = 'overview' | 'dashboard' | 'node-editor' | 'twin-config';

export default function ProfileDetailPage() {
  const { profileId } = useParams<{ profileId: string }>();
  const navigate = useNavigate();
  const { currentUser } = useAuthStore();
  const { profiles, setActiveProfile, updateProfile } = useProfileStore();
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
      <div className="shrink-0 px-6 pt-4 pb-0 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700">
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
                Gemelos Digitales
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
        <div className="flex items-center gap-0.5 overflow-x-auto">
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
          <TabButton
            id="tab-twin-config"
            active={activeTab === 'twin-config'}
            onClick={() => setActiveTab('twin-config')}
            icon={<Sliders className="w-4 h-4" />}
            label="Configuración Física, 3D e IA"
            color="#f59e0b"
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
            onGoToConfig={() => setActiveTab('twin-config')}
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
        {activeTab === 'twin-config' && (
          <TwinConfigTab profile={profile} updateProfile={updateProfile} />
        )}
      </div>
    </div>
  );
}

// ── Twin & Physics Configuration Tab ──
function TwinConfigTab({ profile, updateProfile }: any) {
  const [cfg, setCfg] = useState(() => JSON.parse(JSON.stringify(profile.config)));
  const [savedNotice, setSavedNotice] = useState(false);

  const handleSave = () => {
    updateProfile(profile.id, { config: cfg });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 3000);
  };

  const handleUpload3D = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`${API_BASE_URL}/api/models/upload-3d`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const up = await res.json();
        setCfg((prev: any) => ({ ...prev, model3dUrl: up.url }));
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6 pb-10">
        <div className="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div>
            <h2 className="text-lg font-bold text-white">
              Parámetros Técnicos de "{profile.name}"
            </h2>
            <p className="text-xs text-slate-400">
              Cualquier ajuste actualiza en vivo el motor estructural (StructuralEngine), el analizador SHM y la vista 3D.
            </p>
          </div>
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg"
          >
            <Save className="w-4 h-4" /> Guardar y Aplicar al Sistema
          </button>
        </div>

        {savedNotice && (
          <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 px-4 py-3 rounded-xl flex items-center gap-2 text-xs">
            <CheckCircle2 className="w-4 h-4" />
            Configuración aplicada al Gemelo Digital y sincronizada con el backend de cálculo SHM.
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
          {/* 3D & Scene Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
            <h3 className="text-sm font-bold text-white border-b border-slate-800 pb-2">
              Geometría 3D, Escena y Ubicación
            </h3>
            <div>
              <label className="block text-slate-400 mb-1">Modelo 3D Activo</label>
              <select
                value={cfg.model3dUrl}
                onChange={e => setCfg({ ...cfg, model3dUrl: e.target.value })}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
              >
                <option value="/models/OC4.glb">/models/OC4.glb (Turbina Offshore OC4)</option>
                <option value="/models/OC4-modal.glb">/models/OC4-modal.glb (Deformación Modal)</option>
                <option value="procedural:bridge">procedural:bridge (Viaducto / Puente SHM)</option>
                <option value="procedural:robot_arm">procedural:robot_arm (Brazo Robótico 6-DOF)</option>
                <option value="procedural:uav">procedural:uav (Dron / UAV Cuadricóptero)</option>
              </select>
            </div>
            <div>
              <label className="flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 cursor-pointer">
                <Upload className="w-4 h-4" />
                <span>Subir nuevo modelo .GLB para este gemelo</span>
                <input type="file" accept=".glb,.gltf" className="hidden" onChange={handleUpload3D} />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">Ubicación</label>
                <input
                  type="text"
                  value={cfg.locationName || ''}
                  onChange={e => setCfg({ ...cfg, locationName: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Escena Blender</label>
                <input
                  type="text"
                  value={cfg.blenderScene || ''}
                  onChange={e => setCfg({ ...cfg, blenderScene: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
            </div>
          </div>

          {/* Connectivity & AI Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
            <h3 className="text-sm font-bold text-white border-b border-slate-800 pb-2">
              Conectividad MQTT y Modelo IA (YOLO Pose)
            </h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">MQTT Broker</label>
                <input
                  type="text"
                  value={cfg.mqttBroker}
                  onChange={e => setCfg({ ...cfg, mqttBroker: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Puerto</label>
                <input
                  type="number"
                  value={cfg.mqttPort}
                  onChange={e => setCfg({ ...cfg, mqttPort: Number(e.target.value) })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Tópico Telemetría</label>
                <input
                  type="text"
                  value={cfg.mqttTopic}
                  onChange={e => setCfg({ ...cfg, mqttTopic: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">Pesos Modelo YOLO (.pt)</label>
                <input
                  type="text"
                  value={cfg.aiConfig?.yoloModelPath || ''}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      aiConfig: { ...cfg.aiConfig, yoloModelPath: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Nº de Keypoints</label>
                <input
                  type="number"
                  value={cfg.aiConfig?.numKeypoints ?? 11}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      aiConfig: { ...cfg.aiConfig, numKeypoints: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
            </div>
          </div>

          {/* Physics & Structural Parameters Card */}
          <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
            <h3 className="text-sm font-bold text-white border-b border-slate-800 pb-2">
              Motor de Cálculo Físico, Líneas de Amarre/Soporte y Fatiga SHM
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-slate-400 mb-1">Escala Froude (λ)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.scaleFactor ?? 100}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, scaleFactor: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Altura Estructura (m)</label>
                <input
                  type="number"
                  step="0.05"
                  value={cfg.physicsConfig?.structureHeight ?? 0.9}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, structureHeight: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Diámetro Base (m)</label>
                <input
                  type="number"
                  step="0.01"
                  value={cfg.physicsConfig?.baseDiameter ?? 0.06}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, baseDiameter: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Límite Elástico (MPa)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.yieldStrength ?? 355}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, yieldStrength: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Módulo Young (GPa)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.youngsModulus ?? 210}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, youngsModulus: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Nº Líneas / Tirantes</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.numMooringLines ?? 3}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, numMooringLines: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Rigidez Horiz. Kh (N/m)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.horizontalStiffness ?? 75000}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, horizontalStiffness: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Vida Útil Diseño (años)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.designLifeYears ?? 25}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, designLifeYears: Number(e.target.value) },
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Overview Tab Component ──
function OverviewTab({ profile, dashboards, onGoToBuilder, onGoToConfig }: any) {
  const defaultDb = profile.defaultDashboardId && dashboards
    ? dashboards.find((d: any) => d.id === profile.defaultDashboardId)
    : null;

  if (!defaultDb) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center max-w-lg bg-white dark:bg-slate-800 p-8 rounded-3xl border border-gray-200 dark:border-slate-700 shadow-sm">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center">
            <LayoutDashboard className="w-10 h-10 text-emerald-500" />
          </div>
          <h3 className="text-xl font-black text-gray-900 dark:text-white mb-2">
            Estudio del Gemelo: {profile.name}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            Puedes fijar un panel personalizado desde el Dashboard Builder o ajustar los parámetros físicos, modelo 3D y red neuronal de este gemelo digital.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              onClick={onGoToBuilder}
              className="inline-flex items-center gap-2 px-5 py-3 bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-500/20 transition-all"
            >
              Ir al Dashboard Builder
            </button>
            <button
              onClick={onGoToConfig}
              className="inline-flex items-center gap-2 px-5 py-3 bg-amber-500 hover:bg-amber-400 text-white text-xs font-bold rounded-xl shadow-lg shadow-amber-500/20 transition-all"
            >
              Configurar Física, 3D e IA
            </button>
          </div>
        </div>
      </div>
    );
  }

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
          width={1100}
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
      className={`relative flex items-center gap-2 px-4 py-3 text-sm font-semibold transition-all rounded-t-xl border-b-2 whitespace-nowrap ${
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

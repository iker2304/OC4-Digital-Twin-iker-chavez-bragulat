// @ts-nocheck - react-grid-layout types have breaking structural issues
import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ArrowLeft, GitBranch, LayoutDashboard, Activity, Sliders, Save, Check, Upload, Search,
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
import { Glyph } from '../components/ui/Glyph';
import { Badge, Button, Card, CardHeader, EmptyState, StatusDot, Tabs } from '../components/ui';

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
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={Search}
          title="Perfil no encontrado"
          description="El gemelo digital solicitado no existe o fue eliminado."
          action={
            <Link to="/profiles">
              <Button variant="primary" icon={ArrowLeft}>
                Volver a gemelos
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  const deployedFlows = (flows || []).filter(f => f?.deployed).length;
  const publishedDashboards = (dashboards || []).filter(d => d?.published).length;

  return (
    <div className="-m-6 lg:-m-8 flex h-[calc(100%+3rem)] lg:h-[calc(100%+4rem)] flex-col overflow-hidden">
      {/* Compact header bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="icon" variant="ghost" icon={ArrowLeft} onClick={() => navigate('/profiles')} title="Volver" />
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-700 dark:border-zinc-800 dark:text-zinc-200"
            style={{ borderLeftWidth: 3, borderLeftColor: profile.color }}
          >
            <Glyph name={profile.icon} size={15} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{profile.name}</h1>
              <Badge tone="success" dot>
                Activo
              </Badge>
            </div>
            <p className="truncate font-mono text-[11px] text-zinc-500">
              {profile.config.mqttBroker}:{profile.config.mqttPort} · {profile.config.mqttTopic} · {flows.length} flujos ({deployedFlows} activos) · {dashboards.length} paneles ({publishedDashboards} publicados)
            </p>
          </div>
        </div>

        <Tabs<Tab>
          value={activeTab}
          onChange={setActiveTab}
          items={[
            { value: 'overview', label: 'Resumen', icon: Activity },
            { value: 'dashboard', label: `Paneles (${dashboards.length})`, icon: LayoutDashboard },
            { value: 'node-editor', label: `Flujos (${flows.length})`, icon: GitBranch },
            { value: 'twin-config', label: 'Configuración', icon: Sliders },
          ]}
        />
      </div>

      {/* Tab Content */}
      <div className="relative flex-1 overflow-hidden">
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
      <div className="mx-auto max-w-5xl space-y-6 pb-10">
        <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Parámetros técnicos de {profile.name}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Los cambios actualizan el motor estructural, el analizador SHM y la vista 3D.
            </p>
          </div>
          <Button variant="primary" icon={savedNotice ? Check : Save} onClick={handleSave}>
            {savedNotice ? 'Guardado' : 'Guardar y aplicar'}
          </Button>
        </Card>

        <div className="grid grid-cols-1 gap-6 text-xs lg:grid-cols-2">
          <Card>
            <CardHeader title="Geometría 3D, escena y ubicación" />
            <div className="space-y-4 p-5">
              <div>
                <label className="ui-label">Modelo 3D activo</label>
                <select
                  value={cfg.model3dUrl}
                  onChange={e => setCfg({ ...cfg, model3dUrl: e.target.value })}
                  className="ui-input"
                >
                  <option value="/models/OC4.glb">/models/OC4.glb (Turbina Offshore OC4)</option>
                  <option value="/models/OC4-modal.glb">/models/OC4-modal.glb (Deformación Modal)</option>
                  <option value="procedural:bridge">procedural:bridge (Viaducto / Puente SHM)</option>
                  <option value="procedural:robot_arm">procedural:robot_arm (Brazo Robótico 6-DOF)</option>
                  <option value="procedural:uav">procedural:uav (Dron / UAV Cuadricóptero)</option>
                </select>
              </div>
              <div>
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800">
                  <Upload className="h-3.5 w-3.5" />
                  <span>Subir nuevo modelo .GLB</span>
                  <input type="file" accept=".glb,.gltf" className="hidden" onChange={handleUpload3D} />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="ui-label">Ubicación</label>
                  <input
                    type="text"
                    value={cfg.locationName || ''}
                    onChange={e => setCfg({ ...cfg, locationName: e.target.value })}
                    className="ui-input"
                  />
                </div>
                <div>
                  <label className="ui-label">Escena Blender</label>
                  <input
                    type="text"
                    value={cfg.blenderScene || ''}
                    onChange={e => setCfg({ ...cfg, blenderScene: e.target.value })}
                    className="ui-input"
                  />
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Conectividad MQTT y modelo IA" />
            <div className="space-y-4 p-5">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="ui-label">Broker MQTT</label>
                  <input
                    type="text"
                    value={cfg.mqttBroker}
                    onChange={e => setCfg({ ...cfg, mqttBroker: e.target.value })}
                    className="ui-input"
                  />
                </div>
                <div>
                  <label className="ui-label">Puerto</label>
                  <input
                    type="number"
                    value={cfg.mqttPort}
                    onChange={e => setCfg({ ...cfg, mqttPort: Number(e.target.value) })}
                    className="ui-input"
                  />
                </div>
                <div>
                  <label className="ui-label">Tópico telemetría</label>
                  <input
                    type="text"
                    value={cfg.mqttTopic}
                    onChange={e => setCfg({ ...cfg, mqttTopic: e.target.value })}
                    className="ui-input font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="ui-label">Pesos modelo YOLO (.pt)</label>
                  <input
                    type="text"
                    value={cfg.aiConfig?.yoloModelPath || ''}
                    onChange={e =>
                      setCfg({
                        ...cfg,
                        aiConfig: { ...cfg.aiConfig, yoloModelPath: e.target.value },
                      })
                    }
                    className="ui-input font-mono"
                  />
                </div>
                <div>
                  <label className="ui-label">Nº de keypoints</label>
                  <input
                    type="number"
                    value={cfg.aiConfig?.numKeypoints ?? 11}
                    onChange={e =>
                      setCfg({
                        ...cfg,
                        aiConfig: { ...cfg.aiConfig, numKeypoints: Number(e.target.value) },
                      })
                    }
                    className="ui-input"
                  />
                </div>
              </div>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title="Motor de cálculo físico, líneas de amarre y fatiga SHM" />
            <div className="grid grid-cols-2 gap-4 p-5 md:grid-cols-4">
              <div>
                <label className="ui-label">Escala Froude (λ)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.scaleFactor ?? 100}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, scaleFactor: Number(e.target.value) },
                    })
                  }
                  className="ui-input"
                />
              </div>
              <div>
                <label className="ui-label">Altura estructura (m)</label>
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
                  className="ui-input"
                />
              </div>
              <div>
                <label className="ui-label">Diámetro base (m)</label>
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
                  className="ui-input"
                />
              </div>
              <div>
                <label className="ui-label">Límite elástico (MPa)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.yieldStrength ?? 355}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, yieldStrength: Number(e.target.value) },
                    })
                  }
                  className="ui-input"
                />
              </div>
              <div>
                <label className="ui-label">Módulo Young (GPa)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.youngsModulus ?? 210}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, youngsModulus: Number(e.target.value) },
                    })
                  }
                  className="ui-input"
                />
              </div>
              <div>
                <label className="ui-label">Nº líneas / tirantes</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.numMooringLines ?? 3}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, numMooringLines: Number(e.target.value) },
                    })
                  }
                  className="ui-input"
                />
              </div>
              <div>
                <label className="ui-label">Rigidez horiz. Kh (N/m)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.horizontalStiffness ?? 75000}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, horizontalStiffness: Number(e.target.value) },
                    })
                  }
                  className="ui-input"
                />
              </div>
              <div>
                <label className="ui-label">Vida útil diseño (años)</label>
                <input
                  type="number"
                  value={cfg.physicsConfig?.designLifeYears ?? 25}
                  onChange={e =>
                    setCfg({
                      ...cfg,
                      physicsConfig: { ...cfg.physicsConfig, designLifeYears: Number(e.target.value) },
                    })
                  }
                  className="ui-input"
                />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Overview Tab Component ──
function OverviewTab({ profile, dashboards, onGoToBuilder, onGoToConfig }: any) {
  const defaultDb =
    profile.defaultDashboardId && dashboards
      ? dashboards.find((d: any) => d.id === profile.defaultDashboardId)
      : null;

  if (!defaultDb) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="max-w-md">
          <EmptyState
            icon={LayoutDashboard}
            title={`Estudio de ${profile.name}`}
            description="Fija un panel desde la pestaña Paneles para mostrarlo aquí o ajusta los parámetros técnicos del gemelo."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" onClick={onGoToBuilder}>
                  Abrir paneles
                </Button>
                <Button variant="secondary" onClick={onGoToConfig}>
                  Configurar parámetros
                </Button>
              </div>
            }
          />
        </Card>
      </div>
    );
  }

  if (!defaultDb.layout || defaultDb.layout.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-400">
        El panel fijado no contiene widgets todavía.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6 custom-scrollbar">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{defaultDb.name}</h2>
              <Badge tone="success" dot>
                En vivo
              </Badge>
            </div>
            {defaultDb.description && <p className="mt-0.5 text-xs text-zinc-500">{defaultDb.description}</p>}
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
            <Card key={widget.id} className="flex flex-col overflow-hidden">
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3.5 py-2 dark:border-zinc-800">
                <p className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{widget.title}</p>
                {widget.streamId && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    <StatusDot tone="success" /> En vivo
                  </span>
                )}
              </div>
              <div className="relative min-h-0 flex-1 p-2">
                <WidgetRenderer widget={widget} />
              </div>
            </Card>
          ))}
        </GridLayout>
      </div>
    </div>
  );
}

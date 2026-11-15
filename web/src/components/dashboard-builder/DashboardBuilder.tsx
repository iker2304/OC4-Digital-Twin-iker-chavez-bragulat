// @ts-nocheck - react-grid-layout types have breaking structural issues
import { useState, useEffect } from 'react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  Plus, Trash2, Edit2, Eye, Globe, X, Layers, Settings2, ChevronDown, Check, Upload,
  Copy, ExternalLink, LayoutDashboard, ArrowLeft, Pin,
} from 'lucide-react';
import {
  useDashboardStore,
  WIDGET_TEMPLATES,
  type Dashboard,
} from '../../store/dashboardStore';
import { useProfileStore } from '../../store/profileStore';
import WidgetRenderer from './widgets/WidgetRenderer';
import { Glyph } from '../ui/Glyph';
import { Badge, Button, Card, EmptyState, StatusDot } from '../ui';

interface DashboardBuilderProps {
  userId: string;
  profileId: string;
}

export default function DashboardBuilder({ userId, profileId }: DashboardBuilderProps) {
  const {
    dashboards,
    activeDashboardId,
    createDashboard,
    deleteDashboard,
    setActiveDashboard,
    addWidget,
    removeWidget,
    updateWidget,
    updateLayout,
    publishDashboard,
    streams,
    loadDashboards,
  } = useDashboardStore();

  const [editMode, setEditMode] = useState(true);
  const [showWidgetPalette, setShowWidgetPalette] = useState(false);
  const [showDashboardList, setShowDashboardList] = useState(false);
  const [showCreateDashboard, setShowCreateDashboard] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [newDbDesc, setNewDbDesc] = useState('');
  const [configuringWidget, setConfiguringWidget] = useState<string | null>(null);
  const [publishSuccess, setPublishSuccess] = useState(false);

  useEffect(() => {
    loadDashboards(userId, profileId);
  }, [userId, profileId, loadDashboards]);

  const activeDashboard = (dashboards || []).find(d => d.id === activeDashboardId);
  const profileStreams = (streams || []).filter(s => s.profileId === profileId);

  const handleCreateDashboard = () => {
    if (!newDbName.trim()) return;
    createDashboard(userId, profileId, newDbName.trim(), newDbDesc.trim());
    setShowCreateDashboard(false);
    setNewDbName('');
    setNewDbDesc('');
  };

  const handleLayoutChange = (newLayout: any) => {
    if (editMode) updateLayout(newLayout);
  };

  const handlePublish = () => {
    if (!activeDashboardId) return;
    publishDashboard(activeDashboardId);
    setPublishSuccess(true);
    setTimeout(() => setPublishSuccess(false), 3000);
  };

  const configuringWidgetData = activeDashboard?.widgets.find(w => w.id === configuringWidget);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top Toolbar */}
      <div className="z-20 flex h-11 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-2">
          {activeDashboard && (
            <Button
              size="icon"
              variant="ghost"
              icon={ArrowLeft}
              onClick={() => setActiveDashboard(null)}
              title="Volver al listado"
            />
          )}

          {/* Dashboard selector */}
          <div className="relative">
            <button
              onClick={() => setShowDashboardList(!showDashboardList)}
              className="flex max-w-[220px] items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <Layers className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="truncate">{activeDashboard ? activeDashboard.name : 'Seleccionar panel'}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-zinc-400" />
            </button>

            {showDashboardList && (
              <div className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                <button
                  onClick={() => {
                    setShowDashboardList(false);
                    setShowCreateDashboard(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  <Plus className="h-3.5 w-3.5" /> Nuevo panel
                </button>
                <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
                <div className="max-h-56 overflow-y-auto">
                  {dashboards.length === 0 ? (
                    <p className="p-3 text-center text-xs text-zinc-400">Sin paneles creados</p>
                  ) : (
                    dashboards.map(d => (
                      <div
                        key={d.id}
                        onClick={() => {
                          setActiveDashboard(d.id);
                          setShowDashboardList(false);
                        }}
                        className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                          d.id === activeDashboardId ? 'bg-zinc-100 dark:bg-zinc-800' : ''
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{d.name}</p>
                          <p className="text-[11px] text-zinc-500">
                            {d.widgets.length} widgets · {d.published ? 'Publicado' : 'Borrador'}
                          </p>
                        </div>
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            deleteDashboard(d.id);
                          }}
                          className="rounded p-1 text-zinc-400 hover:text-red-500"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {activeDashboard && (
            <span className="text-xs text-zinc-500">
              {activeDashboard.widgets.length} widgets
              {activeDashboard.published ? ' · Publicado' : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {activeDashboard && (
            <>
              <Button
                size="sm"
                variant={showWidgetPalette ? 'primary' : 'secondary'}
                icon={Plus}
                onClick={() => setShowWidgetPalette(!showWidgetPalette)}
              >
                Añadir widget
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={editMode ? Edit2 : Eye}
                onClick={() => setEditMode(!editMode)}
              >
                {editMode ? 'Editando' : 'Vista'}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={publishSuccess ? Check : Globe}
                onClick={handlePublish}
              >
                {publishSuccess ? 'Publicado' : 'Publicar'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto p-6">
          {!activeDashboard ? (
            <div className="mx-auto max-w-6xl space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Gestor de paneles</h2>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Configuraciones visuales personalizadas para este gemelo digital.
                  </p>
                </div>
                <Button variant="primary" icon={Plus} onClick={() => setShowCreateDashboard(true)}>
                  Nuevo panel
                </Button>
              </div>

              {dashboards.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={LayoutDashboard}
                    title="No hay paneles todavía"
                    description="Crea tu primer panel para visualizar datos de este gemelo digital."
                    action={
                      <Button variant="primary" icon={Plus} onClick={() => setShowCreateDashboard(true)}>
                        Crear panel
                      </Button>
                    }
                  />
                </Card>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {dashboards.map(dashboard => (
                    <DashboardCard
                      key={dashboard.id}
                      dashboard={dashboard}
                      onOpen={() => setActiveDashboard(dashboard.id)}
                      onDelete={() => deleteDashboard(dashboard.id)}
                      onDuplicate={() => {
                        createDashboard(userId, profileId, `${dashboard.name} (Copia)`, dashboard.description);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : activeDashboard.widgets.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Card className="max-w-sm">
                <EmptyState
                  icon={LayoutDashboard}
                  title="El panel está vacío"
                  description="Añade un widget desde la biblioteca para empezar a construir el panel."
                  action={
                    <Button variant="primary" icon={Plus} onClick={() => setShowWidgetPalette(true)}>
                      Añadir primer widget
                    </Button>
                  }
                />
              </Card>
            </div>
          ) : (
            <GridLayout
              className="layout"
              layout={activeDashboard.layout}
              cols={12}
              rowHeight={80}
              width={1200}
              isDraggable={editMode}
              isResizable={editMode}
              onLayoutChange={handleLayoutChange}
              margin={[12, 12]}
              containerPadding={[0, 0]}
            >
              {activeDashboard.widgets.map(widget => {
                const stream = streams.find(s => s.id === widget.streamId);
                return (
                  <Card
                    key={widget.id}
                    className={`flex flex-col overflow-hidden ${editMode ? 'border-dashed' : ''}`}
                  >
                    <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                          {widget.title}
                        </p>
                        {stream && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            <StatusDot tone="success" /> En vivo
                          </span>
                        )}
                        {!stream && widget.type !== 'map' && widget.type !== 'model3d' && (
                          <span className="shrink-0 text-[10px] text-zinc-400">Demo</span>
                        )}
                      </div>
                      {editMode && (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            onClick={() => setConfiguringWidget(widget.id)}
                            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => removeWidget(widget.id)}
                            className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 overflow-hidden p-2">
                      <WidgetRenderer widget={widget} stream={stream} editMode={editMode} />
                    </div>
                  </Card>
                );
              })}
            </GridLayout>
          )}
        </div>

        {/* Widget Palette Sidebar */}
        {showWidgetPalette && activeDashboard && (
          <div className="flex w-64 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
              <span className="ui-eyebrow">Widgets</span>
              <button
                onClick={() => setShowWidgetPalette(false)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto p-2 custom-scrollbar">
              {WIDGET_TEMPLATES.map(tpl => (
                <button
                  key={tpl.type}
                  onClick={() => addWidget(tpl)}
                  className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-900"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                    <Glyph name={tpl.icon} size={15} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{tpl.label}</p>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500">{tpl.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Widget Config Modal */}
      {configuringWidgetData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Configurar widget</h3>
              <Button size="icon" variant="ghost" icon={X} onClick={() => setConfiguringWidget(null)} />
            </div>
            <div className="space-y-4 text-xs">
              <div>
                <label className="ui-label">Título</label>
                <input
                  type="text"
                  value={configuringWidgetData.title}
                  onChange={e => updateWidget(configuringWidgetData.id, { title: e.target.value })}
                  className="ui-input"
                />
              </div>

              <div>
                <label className="ui-label">Flujo de datos</label>
                {profileStreams.length === 0 ? (
                  <div className="mb-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
                    Sin flujos registrados. Despliega antes un flujo con un nodo Dashboard Stream.
                  </div>
                ) : (
                  <select
                    value={configuringWidgetData.streamId || ''}
                    onChange={e => updateWidget(configuringWidgetData.id, { streamId: e.target.value || null })}
                    className="ui-input mb-2"
                  >
                    <option value="">— Seleccionar flujo —</option>
                    {profileStreams.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.label} ({s.id.slice(0, 8)}…)
                      </option>
                    ))}
                  </select>
                )}
                <label className="ui-label">O introducir ID manualmente</label>
                <input
                  type="text"
                  value={configuringWidgetData.streamId || ''}
                  onChange={e => updateWidget(configuringWidgetData.id, { streamId: e.target.value || null })}
                  placeholder="UUID del stream"
                  className="ui-input font-mono"
                />
              </div>

              {(() => {
                const template = WIDGET_TEMPLATES.find(t => t.type === configuringWidgetData.type);
                const fullConfig = { ...(template?.defaultConfig || {}), ...configuringWidgetData.config };
                if (Object.keys(fullConfig).length === 0) return null;

                return (
                  <div className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                    <p className="ui-eyebrow">Propiedades</p>
                    {Object.entries(fullConfig).map(([key, value]) => (
                      <div key={key}>
                        <label className="ui-label capitalize">
                          {key.replace(/([A-Z])/g, ' $1').trim()}
                        </label>
                        {typeof value === 'boolean' ? (
                          <Button
                            size="sm"
                            variant={value ? 'primary' : 'secondary'}
                            icon={value ? Check : undefined}
                            onClick={() =>
                              updateWidget(configuringWidgetData.id, {
                                config: { ...configuringWidgetData.config, [key]: !value },
                              })
                            }
                          >
                            {value ? 'Activado' : 'Desactivado'}
                          </Button>
                        ) : typeof value === 'number' ? (
                          <input
                            type="number"
                            value={value as number}
                            onChange={e =>
                              updateWidget(configuringWidgetData.id, {
                                config: { ...configuringWidgetData.config, [key]: parseFloat(e.target.value) || 0 },
                              })
                            }
                            className="ui-input"
                          />
                        ) : key === 'scenePath' ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={String(value)}
                              onChange={e =>
                                updateWidget(configuringWidgetData.id, {
                                  config: { ...configuringWidgetData.config, [key]: e.target.value },
                                })
                              }
                              className="ui-input"
                              placeholder="/models/OC4.glb"
                            />
                            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                              <Upload className="h-3.5 w-3.5" />
                              <span>Subir archivo .glb / .gltf</span>
                              <input
                                type="file"
                                accept=".glb,.gltf"
                                className="hidden"
                                onChange={e => {
                                  const file = e.target.files?.[0];
                                  if (file) {
                                    const url = URL.createObjectURL(file);
                                    updateWidget(configuringWidgetData.id, {
                                      config: { ...configuringWidgetData.config, [key]: url },
                                    });
                                  }
                                }}
                              />
                            </label>
                          </div>
                        ) : (
                          <input
                            type="text"
                            value={String(value || '')}
                            onChange={e =>
                              updateWidget(configuringWidgetData.id, {
                                config: { ...configuringWidgetData.config, [key]: e.target.value },
                              })
                            }
                            className="ui-input"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div className="mt-6 flex justify-end">
              <Button variant="primary" onClick={() => setConfiguringWidget(null)}>
                Listo
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Create Dashboard Modal */}
      {showCreateDashboard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">Crear panel</h3>
            <div className="space-y-4">
              <div>
                <label className="ui-label">Nombre</label>
                <input
                  autoFocus
                  type="text"
                  value={newDbName}
                  onChange={e => setNewDbName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateDashboard()}
                  className="ui-input"
                  placeholder="Ej. Resumen operativo, Monitor de fatiga…"
                />
              </div>
              <div>
                <label className="ui-label">Descripción</label>
                <textarea
                  value={newDbDesc}
                  onChange={e => setNewDbDesc(e.target.value)}
                  rows={3}
                  className="ui-input resize-none"
                  placeholder="¿Qué muestra este panel?"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowCreateDashboard(false);
                  setNewDbName('');
                  setNewDbDesc('');
                }}
              >
                Cancelar
              </Button>
              <Button variant="primary" onClick={handleCreateDashboard} disabled={!newDbName.trim()}>
                Crear panel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dashboard Card component ──
function DashboardCard({
  dashboard,
  onOpen,
  onDelete,
  onDuplicate,
}: {
  dashboard: Dashboard;
  onOpen: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { profiles, updateProfile } = useProfileStore();
  const profile = profiles.find(p => p.id === dashboard.profileId);
  const isPinned = profile?.defaultDashboardId === dashboard.id;

  const togglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!profile) return;
    updateProfile(profile.id, {
      defaultDashboardId: isPinned ? undefined : dashboard.id,
    });
  };

  return (
    <Card className="flex h-full flex-col justify-between p-5">
      <div>
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
              <Glyph name={profile?.icon} size={15} />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{dashboard.name}</h3>
              <p className="truncate text-[11px] text-zinc-500">{profile?.name || 'Perfil'}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={togglePin}
              className={`rounded-md p-1.5 transition-colors ${
                isPinned
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
              title={isPinned ? 'Desfijar del resumen' : 'Fijar en el resumen'}
            >
              <Pin className="h-3.5 w-3.5" />
            </button>
            <Badge tone={dashboard.published ? 'success' : 'neutral'}>
              {dashboard.published ? 'Publicado' : 'Borrador'}
            </Badge>
          </div>
        </div>

        <p className="mb-4 line-clamp-2 text-xs text-zinc-500">
          {dashboard.description || 'Sin descripción.'}
        </p>

        <div className="mb-4 flex items-center gap-4 border-y border-zinc-100 py-2.5 text-xs text-zinc-500 dark:border-zinc-800">
          <span>{dashboard.widgets.length} widgets</span>
          <span>·</span>
          <span>
            Actualizado {new Date(dashboard.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="primary" icon={ExternalLink} onClick={onOpen} className="flex-1 justify-center">
          Abrir
        </Button>
        <Button size="icon" variant="ghost" icon={Copy} onClick={onDuplicate} title="Duplicar" />
        <Button size="icon" variant="ghost" icon={Trash2} onClick={onDelete} title="Eliminar" />
      </div>
    </Card>
  );
}

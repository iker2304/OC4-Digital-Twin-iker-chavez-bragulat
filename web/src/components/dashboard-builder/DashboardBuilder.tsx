// @ts-nocheck - react-grid-layout types have breaking structural issues
import { useState, useEffect } from 'react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  Plus, Trash2, Edit2, Eye, Globe, X, Layers,
  Settings2, ChevronDown, Check, Upload,
  Copy, Clock, ExternalLink, LayoutDashboard, ArrowLeft, Pin
} from 'lucide-react';
import {
  useDashboardStore,
  WIDGET_TEMPLATES,
  type Dashboard
} from '../../store/dashboardStore';
import { useProfileStore } from '../../store/profileStore';
import WidgetRenderer from './widgets/WidgetRenderer';

type LayoutItem = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number };


interface DashboardBuilderProps {
  userId: string;
  profileId: string;
}

export default function DashboardBuilder({ userId, profileId }: DashboardBuilderProps) {
  const {
    dashboards, activeDashboardId,
    createDashboard, deleteDashboard, setActiveDashboard,
    addWidget, removeWidget, updateWidget,
    updateLayout, publishDashboard,
    streams, loadDashboards,
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
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--app-bg)' }}>
      {/* ── Top Toolbar ── */}
      <div className="h-12 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between px-3 shrink-0 z-20">
        <div className="flex items-center gap-1">
          {activeDashboard && (
            <button
              onClick={() => setActiveDashboard(null)}
              className="flex items-center justify-center p-1.5 rounded-xl text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-slate-700 transition-all mr-1"
              title="Back to Dashboard Manager"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          
          {/* Dashboard selector */}
          <div className="relative">
            <button
              onClick={() => setShowDashboardList(!showDashboardList)}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-slate-700 rounded-xl text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-600 border border-gray-200 dark:border-slate-600 transition-all max-w-[200px]"
            >
              <Layers className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <span className="truncate">{activeDashboard ? activeDashboard.name : 'Select Dashboard'}</span>
              <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />
            </button>

            {showDashboardList && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-2xl z-50 overflow-hidden">
                <div className="p-2 border-b border-gray-100 dark:border-slate-700">
                  <button
                    onClick={() => { setShowDashboardList(false); setShowCreateDashboard(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 text-xs font-semibold hover:bg-purple-100 dark:hover:bg-purple-500/20 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" /> New Dashboard
                  </button>
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {dashboards.length === 0 ? (
                    <p className="p-4 text-center text-xs text-gray-400">No dashboards yet</p>
                  ) : dashboards.map(d => (
                    <div
                      key={d.id}
                      onClick={() => { setActiveDashboard(d.id); setShowDashboardList(false); }}
                      className={`flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-700 cursor-pointer border-b border-gray-50 dark:border-slate-700/50 last:border-0 ${d.id === activeDashboardId ? 'bg-purple-50 dark:bg-purple-500/10' : ''}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-semibold truncate ${d.id === activeDashboardId ? 'text-purple-600 dark:text-purple-400' : 'text-gray-700 dark:text-gray-300'}`}>{d.name}</p>
                        <p className="text-[10px] text-gray-400">{d.widgets.length} widgets · {d.published ? '🟢 Published' : '⚪ Draft'}</p>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); deleteDashboard(d.id); }}
                        className="p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-all"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {activeDashboard && (
            <div className="flex items-center gap-1 text-[10px] text-gray-400">
              <span>{activeDashboard.widgets.length} widgets</span>
              {activeDashboard.published && (
                <>
                  <span className="text-gray-300">·</span>
                  <span className="text-emerald-500 font-semibold">● Published</span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {activeDashboard && (
            <>
              {/* Add Widget */}
              <button
                onClick={() => setShowWidgetPalette(!showWidgetPalette)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all border ${
                  showWidgetPalette
                    ? 'bg-purple-100 dark:bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-500/30'
                    : 'bg-white dark:bg-slate-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-600'
                }`}
              >
                <Plus className="w-3.5 h-3.5" /> Add Widget
              </button>

              {/* Edit/View toggle */}
              <button
                onClick={() => setEditMode(!editMode)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all border ${
                  editMode
                    ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/30'
                    : 'bg-gray-50 dark:bg-slate-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-slate-600 hover:bg-gray-100 dark:hover:bg-slate-600'
                }`}
              >
                {editMode ? <Edit2 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                {editMode ? 'Editing' : 'Viewing'}
              </button>

              <div className="w-px h-5 bg-gray-200 dark:bg-slate-700" />

              {/* Publish */}
              <button
                onClick={handlePublish}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-sm ${
                  publishSuccess
                    ? 'bg-emerald-500 text-white shadow-emerald-500/30'
                    : 'bg-gradient-to-r from-purple-500 to-pink-500 text-white hover:from-purple-400 hover:to-pink-400 shadow-purple-500/20'
                }`}
              >
                {publishSuccess ? <Check className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
                {publishSuccess ? 'Published!' : 'Publish'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Main area ── */}
      <div className="flex-1 overflow-hidden flex">
        {/* Canvas */}
        <div className="flex-1 overflow-auto p-3">
          {!activeDashboard ? (
            // ── Dashboard Manager ──
            <div className="h-full flex flex-col bg-gray-50 dark:bg-slate-900 overflow-y-auto custom-scrollbar p-8 rounded-2xl border border-gray-200 dark:border-slate-800">
              <div className="max-w-6xl mx-auto w-full">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h2 className="text-2xl font-black text-gray-900 dark:text-white">Dashboard Manager</h2>
                    <p className="text-sm text-gray-500 mt-1">Manage and monitor all UI configurations for this profile.</p>
                  </div>
                  <button
                    onClick={() => setShowCreateDashboard(true)}
                    className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-sm font-bold rounded-xl shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40 hover:-translate-y-0.5 transition-all"
                  >
                    <Plus className="w-4 h-4" /> Create New Dashboard
                  </button>
                </div>

                {dashboards.length === 0 ? (
                  <div className="bg-white dark:bg-slate-800 rounded-3xl border-2 border-dashed border-gray-200 dark:border-slate-700 p-12 text-center">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-purple-50 dark:bg-purple-500/10 flex items-center justify-center">
                      <LayoutDashboard className="w-8 h-8 text-purple-500" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-700 dark:text-gray-300">No dashboards yet</h3>
                    <p className="text-sm text-gray-400 mt-2 mb-6">Start by creating your first dashboard to visualize your digital twin data.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {dashboards.map(dashboard => (
                      <DashboardCard 
                        key={dashboard.id} 
                        dashboard={dashboard} 
                        onOpen={() => setActiveDashboard(dashboard.id)}
                        onDelete={() => deleteDashboard(dashboard.id)}
                        onDuplicate={() => {
                          // Simple duplication
                          createDashboard(userId, profileId, `${dashboard.name} (Copy)`, dashboard.description);
                          // For a full copy we would need to duplicate layout and widgets in the store. Let's keep it simple for now or implement deep copy in store.
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : activeDashboard.widgets.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <p className="text-5xl mb-4">📊</p>
                <p className="text-base font-bold text-gray-600 dark:text-gray-300 mb-2">Dashboard is empty</p>
                <p className="text-sm text-gray-400 mb-4">Click "Add Widget" to start building</p>
                <button
                  onClick={() => setShowWidgetPalette(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-purple-100 dark:bg-purple-500/15 text-purple-600 dark:text-purple-400 text-sm font-semibold rounded-xl hover:bg-purple-200 dark:hover:bg-purple-500/25 transition-all"
                >
                  <Plus className="w-4 h-4" /> Add First Widget
                </button>
              </div>
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
                  <div
                    key={widget.id}
                    className={`bg-white dark:bg-slate-800 rounded-2xl border overflow-hidden flex flex-col transition-all ${
                      editMode
                        ? 'border-dashed border-gray-300 dark:border-slate-600 hover:border-purple-400 dark:hover:border-purple-500'
                        : 'border-gray-100 dark:border-slate-700 shadow-sm'
                    }`}
                  >
                    {/* Widget header */}
                    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-slate-700 shrink-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-xs font-bold text-gray-700 dark:text-gray-300 truncate">{widget.title}</p>
                        {stream && (
                          <span className="flex items-center gap-1 text-[9px] text-emerald-500 font-semibold shrink-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            Live
                          </span>
                        )}
                        {!stream && widget.type !== 'map' && widget.type !== 'model3d' && (
                          <span className="text-[9px] text-gray-400 shrink-0">Demo data</span>
                        )}
                      </div>
                      {editMode && (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            onClick={() => setConfiguringWidget(widget.id)}
                            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-600 transition-all"
                          >
                            <Settings2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => removeWidget(widget.id)}
                            className="p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-all"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Widget content */}
                    <div className="flex-1 overflow-hidden p-2">
                      <WidgetRenderer widget={widget} stream={stream} editMode={editMode} />
                    </div>
                  </div>
                );
              })}
            </GridLayout>
          )}
        </div>

        {/* ── Widget Palette Sidebar ── */}
        {showWidgetPalette && activeDashboard && (
          <div className="w-60 bg-white dark:bg-slate-800 border-l border-gray-200 dark:border-slate-700 flex flex-col shrink-0">
            <div className="p-3 border-b border-gray-100 dark:border-slate-700 flex items-center justify-between">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Widgets</p>
              <button
                onClick={() => setShowWidgetPalette(false)}
                className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 transition-all"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 custom-scrollbar space-y-1">
              {WIDGET_TEMPLATES.map(tpl => (
                <button
                  key={tpl.type}
                  onClick={() => addWidget(tpl)}
                  className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl border border-transparent hover:border-gray-200 dark:hover:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-all text-left group"
                >
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 transition-transform group-hover:scale-110"
                    style={{ background: `${tpl.color}15`, border: `1px solid ${tpl.color}25` }}
                  >
                    {tpl.icon}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate">{tpl.label}</p>
                    <p className="text-[9px] text-gray-400 leading-tight mt-0.5 truncate">{tpl.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Widget Config Modal ── */}
      {configuringWidgetData && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 p-6 max-w-md w-full shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-bold text-gray-900 dark:text-white">Configure Widget</h3>
              <button
                onClick={() => setConfiguringWidget(null)}
                className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-slate-700 transition-all"
              >
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            <div className="space-y-4">
              {/* Title */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Widget Title</label>
                <input
                  type="text"
                  value={configuringWidgetData.title}
                  onChange={e => updateWidget(configuringWidgetData.id, { title: e.target.value })}
                  className="w-full px-3 py-2.5 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/30 transition-all"
                />
              </div>

              {/* Stream connector */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">Data Stream</label>
                {profileStreams.length === 0 ? (
                  <div className="px-3 py-2.5 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-400 mb-2">
                    No streams registered. Deploy a flow with "Dashboard Stream" node first.
                  </div>
                ) : (
                  <select
                    value={configuringWidgetData.streamId || ''}
                    onChange={e => updateWidget(configuringWidgetData.id, { streamId: e.target.value || null })}
                    className="w-full px-3 py-2.5 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/30 transition-all mb-2"
                  >
                    <option value="">— Select a stream —</option>
                    {profileStreams.map(s => (
                      <option key={s.id} value={s.id}>{s.label} ({s.id.slice(0,8)}...)</option>
                    ))}
                  </select>
                )}
                <div className="mt-2">
                  <label className="block text-[10px] font-semibold text-gray-400 mb-1">Or enter Stream ID manually:</label>
                  <input
                    type="text"
                    value={configuringWidgetData.streamId || ''}
                    onChange={e => updateWidget(configuringWidgetData.id, { streamId: e.target.value || null })}
                    placeholder="e.g. 151e7fa0-df8b-4246-a625-4bb50bf39f3c"
                    className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/30 transition-all font-mono"
                  />
                </div>
              </div>

              {/* Internal Config Editor */}
              {(() => {
                const template = WIDGET_TEMPLATES.find(t => t.type === configuringWidgetData.type);
                const fullConfig = { ...(template?.defaultConfig || {}), ...configuringWidgetData.config };
                if (Object.keys(fullConfig).length === 0) return null;

                return (
                  <div className="space-y-4 pt-4 border-t border-gray-100 dark:border-slate-700">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Widget Properties</p>
                    <div className="grid grid-cols-1 gap-3">
                      {Object.entries(fullConfig).map(([key, value]) => (
                      <div key={key}>
                        <label className="block text-[11px] font-semibold text-gray-500 mb-1 capitalize">
                          {key.replace(/([A-Z])/g, ' $1').trim()}
                        </label>
                        {typeof value === 'boolean' ? (
                          <button
                            onClick={() => updateWidget(configuringWidgetData.id, { 
                              config: { ...configuringWidgetData.config, [key]: !value } 
                            })}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                              value
                                ? 'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-400'
                                : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-gray-400'
                            }`}
                          >
                            {value ? '✓ Enabled' : '○ Disabled'}
                          </button>
                        ) : typeof value === 'number' ? (
                          <input
                            type="number"
                            value={value as number}
                            onChange={e => updateWidget(configuringWidgetData.id, { 
                              config: { ...configuringWidgetData.config, [key]: parseFloat(e.target.value) || 0 } 
                            })}
                            className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500/30"
                          />
                        ) : key === 'scenePath' ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={String(value)}
                              onChange={e => updateWidget(configuringWidgetData.id, { 
                                config: { ...configuringWidgetData.config, [key]: e.target.value } 
                              })}
                              className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500/30"
                              placeholder="e.g. /models/platform.glb"
                            />
                            <label className="flex items-center justify-center gap-2 px-3 py-2 border-2 border-dashed border-gray-200 dark:border-slate-700 rounded-xl cursor-pointer hover:bg-purple-50 dark:hover:bg-purple-500/10 hover:border-purple-300 transition-all group">
                              <Upload className="w-3.5 h-3.5 text-gray-400 group-hover:text-purple-500" />
                              <span className="text-[10px] font-bold text-gray-500 group-hover:text-purple-600 uppercase">Upload Model File</span>
                              <input 
                                type="file" 
                                accept=".glb,.gltf" 
                                className="hidden" 
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) {
                                    const url = URL.createObjectURL(file);
                                    updateWidget(configuringWidgetData.id, { 
                                      config: { ...configuringWidgetData.config, [key]: url } 
                                    });
                                  }
                                }}
                              />
                            </label>
                            <p className="text-[9px] text-gray-400">Accepted formats: .glb, .gltf</p>
                          </div>
                        ) : (
                          <input
                            type="text"
                            value={String(value || '')}
                            onChange={e => updateWidget(configuringWidgetData.id, { 
                              config: { ...configuringWidgetData.config, [key]: e.target.value } 
                            })}
                            className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500/30"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                );
              })()}
            </div> {/* Close space-y-4 */}
            <button
              onClick={() => setConfiguringWidget(null)}
              className="mt-6 w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-semibold transition-all shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* ── Create Dashboard Modal ── */}
      {showCreateDashboard && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 p-8 max-w-md w-full shadow-2xl">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6">Create Dashboard</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Dashboard Name</label>
                <input
                  autoFocus
                  type="text"
                  value={newDbName}
                  onChange={e => setNewDbName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateDashboard()}
                  className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all"
                  placeholder="e.g. Operations Overview, Fatigue Monitor..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Description</label>
                <textarea
                  value={newDbDesc}
                  onChange={e => setNewDbDesc(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all resize-none"
                  placeholder="What does this dashboard show?"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowCreateDashboard(false); setNewDbName(''); setNewDbDesc(''); }}
                className="flex-1 py-3 rounded-xl bg-gray-100 hover:bg-gray-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 font-medium text-sm transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateDashboard}
                disabled={!newDbName.trim()}
                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-400 hover:to-pink-400 text-white font-semibold text-sm transition-all shadow-lg shadow-purple-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Dashboard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dashboard Card component ──
function DashboardCard({ 
  dashboard, onOpen, onDelete, onDuplicate 
}: { 
  dashboard: Dashboard; onOpen: () => void; onDelete: () => void; onDuplicate: () => void; 
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
    <div className="group bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 p-5 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col h-full">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div 
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
            style={{ background: `${profile?.color || '#a855f7'}15`, border: `1px solid ${profile?.color || '#a855f7'}30` }}
          >
            {profile?.icon || '📦'}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-gray-900 dark:text-white truncate group-hover:text-purple-500 transition-colors">
              {dashboard.name}
            </h3>
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">
              {profile?.name || 'Unknown Profile'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={togglePin}
            className={`p-1.5 rounded-lg transition-all ${
              isPinned
                ? 'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-400'
                : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700'
            }`}
             title={isPinned ? 'Unpin from Overview' : 'Pin to Profile Overview'}
          >
            <Pin className={`w-3.5 h-3.5 ${isPinned ? 'fill-current' : ''}`} />
          </button>
          <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold shrink-0 ${dashboard.published ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400' : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-gray-400'}`}>
            {dashboard.published ? 'PUBLISHED' : 'DRAFT'}
          </span>
        </div>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mb-6 flex-1">
        {dashboard.description || 'No description provided for this visual dashboard.'}
      </p>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-gray-50 dark:bg-slate-900/50 rounded-2xl p-3 border border-gray-100 dark:border-slate-700/50">
          <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Widgets</p>
          <div className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-purple-500" />
            <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{dashboard.widgets.length}</span>
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-slate-900/50 rounded-2xl p-3 border border-gray-100 dark:border-slate-700/50">
          <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Updated</p>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-orange-500" />
            <span className="text-xs font-bold text-gray-700 dark:text-gray-200">
              {new Date(dashboard.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-4 border-t border-gray-50 dark:border-slate-700/50 mt-auto">
        <button
          onClick={onOpen}
          className="flex-1 flex items-center justify-center gap-2 py-2 px-3 bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 text-xs font-bold rounded-xl hover:bg-purple-600 hover:text-white dark:hover:bg-purple-500 transition-all shadow-sm"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Open Builder
        </button>
        <div className="flex gap-1">
          <button
            onClick={onDuplicate}
            className="p-2 rounded-xl text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-all"
            title="Duplicate"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-2 rounded-xl text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 transition-all"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

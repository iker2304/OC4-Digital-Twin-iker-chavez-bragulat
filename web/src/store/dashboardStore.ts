import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

// Local layout item type (avoids react-grid-layout @types issues)
export type LayoutItem = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number };

// ========== Widget Types ==========
export type WidgetType =
  | 'timeseries'
  | 'gauge'
  | 'kpi'
  | 'map'
  | 'model3d'
  | 'sensor_table'
  | 'ai_insights'
  | 'bar_chart'
  | 'heatmap';

export interface DashboardWidget {
  id: string;
  type: WidgetType;
  title: string;
  streamId: string | null; // connected stream from dashboard_stream node
  config: Record<string, unknown>;
}

export interface WidgetTemplate {
  type: WidgetType;
  label: string;
  description: string;
  icon: string;
  color: string;
  defaultW: number;
  defaultH: number;
  defaultConfig: Record<string, unknown>;
}

export const WIDGET_TEMPLATES: WidgetTemplate[] = [
  {
    type: 'timeseries',
    label: 'Time-Series Chart',
    description: 'Real-time scrolling chart for sensor data',
    icon: '📈',
    color: '#3b82f6',
    defaultW: 6,
    defaultH: 3,
    defaultConfig: { yLabel: 'Value', color: '#3b82f6', maxPoints: 100 },
  },
  {
    type: 'gauge',
    label: 'Gauge / Speedometer',
    description: 'Circular gauge for a single metric',
    icon: '⏱️',
    color: '#10b981',
    defaultW: 3,
    defaultH: 3,
    defaultConfig: { min: 0, max: 100, unit: '%', thresholds: [70, 90] },
  },
  {
    type: 'kpi',
    label: 'KPI Card',
    description: 'Key Performance Indicator display',
    icon: '📊',
    color: '#6366f1',
    defaultW: 3,
    defaultH: 2,
    defaultConfig: { unit: '', precision: 2, trend: true },
  },
  {
    type: 'map',
    label: 'Geo Map',
    description: 'Live geographical position map',
    icon: '🗺️',
    color: '#06b6d4',
    defaultW: 6,
    defaultH: 4,
    defaultConfig: { lat: 56.0, lon: 3.5, zoom: 8 },
  },
  {
    type: 'model3d',
    label: '3D Model Viewer',
    description: 'Interactive 3D digital twin model',
    icon: '🎨',
    color: '#f97316',
    defaultW: 6,
    defaultH: 5,
    defaultConfig: { scenePath: '', autoRotate: false, showGrid: true, wireframe: false },
  },
  {
    type: 'sensor_table',
    label: 'Sensor Table',
    description: 'Tabular view of all sensor readings',
    icon: '📋',
    color: '#8b5cf6',
    defaultW: 6,
    defaultH: 3,
    defaultConfig: { showTimestamp: true, maxRows: 20 },
  },
  {
    type: 'ai_insights',
    label: 'AI Insights',
    description: 'AI-generated anomaly and predictions summary',
    icon: '🤖',
    color: '#ec4899',
    defaultW: 4,
    defaultH: 3,
    defaultConfig: { model: 'anomaly_detection', confidence: 0.85 },
  },
  {
    type: 'bar_chart',
    label: 'Bar Chart',
    description: 'Comparative bar chart for categories',
    icon: '📉',
    color: '#14b8a6',
    defaultW: 4,
    defaultH: 3,
    defaultConfig: { orientation: 'vertical', color: '#14b8a6' },
  },
];

// ========== Dashboard Definition ==========
export interface Dashboard {
  id: string;
  userId: string;
  profileId: string;
  name: string;
  description: string;
  layout: LayoutItem[];
  widgets: DashboardWidget[];
  published: boolean;
  createdAt: number;
  updatedAt: number;
}

// ========== Stream Registry ==========
export interface StreamDefinition {
  id: string;
  label: string;
  type: 'timeseries' | 'snapshot' | 'alert';
  profileId: string;
  flowId: string;
  nodeId: string;
  lastValue?: unknown;
  updatedAt: number;
}

// ========== Store ==========
interface DashboardStore {
  dashboards: Dashboard[];
  activeDashboardId: string | null;
  streams: StreamDefinition[];

  // CRUD
  loadDashboards: (userId: string, profileId: string) => void;
  createDashboard: (userId: string, profileId: string, name: string, description: string) => Dashboard;
  deleteDashboard: (dashboardId: string) => void;
  setActiveDashboard: (id: string | null) => void;
  updateDashboardMeta: (id: string, updates: Partial<Pick<Dashboard, 'name' | 'description'>>) => void;

  // Widget actions
  addWidget: (template: WidgetTemplate) => void;
  removeWidget: (widgetId: string) => void;
  updateWidget: (widgetId: string, updates: Partial<DashboardWidget>) => void;
  connectWidgetToStream: (widgetId: string, streamId: string) => void;

  // Layout actions
  updateLayout: (layout: LayoutItem[]) => void;

  // Stream registry
  registerStream: (stream: Omit<StreamDefinition, 'updatedAt'>) => void;
  updateStreamValue: (streamId: string, value: unknown) => void;
  getStreamsForProfile: (profileId: string) => StreamDefinition[];
  startStreamPolling: () => void;

  // Publish
  publishDashboard: (dashboardId: string) => void;

  // Persistence
  saveCurrentDashboard: () => void;
}

const DASHBOARDS_KEY = 'oc4_dt_dashboards';
const STREAMS_KEY = 'oc4_dt_streams';

function getAllDashboards(): Dashboard[] {
  try {
    const raw = localStorage.getItem(DASHBOARDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAllDashboards(dbs: Dashboard[]) {
  localStorage.setItem(DASHBOARDS_KEY, JSON.stringify(dbs));
  fetch('http://localhost:8080/persist/dashboards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dbs),
  }).catch(() => {});
}

function getAllStreams(): StreamDefinition[] {
  try {
    const raw = localStorage.getItem(STREAMS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAllStreams(streams: StreamDefinition[]) {
  localStorage.setItem(STREAMS_KEY, JSON.stringify(streams));
  fetch('http://localhost:8080/persist/streams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(streams),
  }).catch(() => {});
}

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  dashboards: [],
  activeDashboardId: null,
  streams: getAllStreams(),

  loadDashboards: async (userId, profileId) => {
    // Load dashboards
    try {
      const res = await fetch('http://localhost:8080/persist/dashboards');
      if (res.ok) {
        const backendDbs = await res.json();
        if (backendDbs && Array.isArray(backendDbs) && backendDbs.length > 0) {
          localStorage.setItem(DASHBOARDS_KEY, JSON.stringify(backendDbs));
        }
      }
    } catch { /* fallback */ }

    // Load streams
    try {
      const res = await fetch('http://localhost:8080/persist/streams');
      if (res.ok) {
        const backendStreams = await res.json();
        if (backendStreams && Array.isArray(backendStreams)) {
          localStorage.setItem(STREAMS_KEY, JSON.stringify(backendStreams));
          set({ streams: backendStreams });
        }
      }
    } catch { /* fallback */ }

    const all = getAllDashboards();
    const filtered = all.filter(d => d.userId === userId && d.profileId === profileId);
    set({ dashboards: filtered });
  },

  createDashboard: (userId, profileId, name, description) => {
    const db: Dashboard = {
      id: uuidv4(),
      userId,
      profileId,
      name,
      description,
      layout: [],
      widgets: [],
      published: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const all = getAllDashboards();
    all.push(db);
    saveAllDashboards(all);
    set(state => ({
      dashboards: [...state.dashboards, db],
      activeDashboardId: db.id,
    }));
    return db;
  },

  deleteDashboard: (dashboardId) => {
    const all = getAllDashboards().filter(d => d.id !== dashboardId);
    saveAllDashboards(all);
    set(state => ({
      dashboards: state.dashboards.filter(d => d.id !== dashboardId),
      activeDashboardId: state.activeDashboardId === dashboardId ? null : state.activeDashboardId,
    }));
  },

  setActiveDashboard: (id) => set({ activeDashboardId: id }),

  updateDashboardMeta: (id, updates) => {
    const all = getAllDashboards();
    const idx = all.findIndex(d => d.id === id);
    if (idx === -1) return;
    const updatedDashboard = { ...all[idx], ...updates, updatedAt: Date.now() };
    all[idx] = updatedDashboard;
    saveAllDashboards(all);
    set(state => ({
      dashboards: state.dashboards.map(d =>
        d.id === id ? { ...d, ...updates, updatedAt: Date.now() } : d,
      ),
    }));
  },

  addWidget: (template) => {
    const { activeDashboardId, dashboards } = get();
    if (!activeDashboardId) return;
    const db = dashboards.find(d => d.id === activeDashboardId);
    if (!db) return;

    const widgetId = uuidv4();
    const newWidget: DashboardWidget = {
      id: widgetId,
      type: template.type,
      title: template.label,
      streamId: null,
      config: { ...template.defaultConfig },
    };
    const newLayoutItem: LayoutItem = {
      i: widgetId,
      x: (db.layout.length * 4) % 12,
      y: Infinity,
      w: template.defaultW,
      h: template.defaultH,
      minW: 2,
      minH: 2,
    };

    const updatedWidgets = [...db.widgets, newWidget];
    const updatedLayout = [...db.layout, newLayoutItem];

    const all = getAllDashboards();
    const idx = all.findIndex(d => d.id === activeDashboardId);
    if (idx !== -1) {
      all[idx] = { ...all[idx], widgets: updatedWidgets, layout: updatedLayout, updatedAt: Date.now() };
      saveAllDashboards(all);
    }

    set(state => ({
      dashboards: state.dashboards.map(d =>
        d.id === activeDashboardId
          ? { ...d, widgets: updatedWidgets, layout: updatedLayout, updatedAt: Date.now() }
          : d,
      ),
    }));
  },

  removeWidget: (widgetId) => {
    const { activeDashboardId, dashboards } = get();
    if (!activeDashboardId) return;
    const db = dashboards.find(d => d.id === activeDashboardId);
    if (!db) return;

    const updatedWidgets = db.widgets.filter(w => w.id !== widgetId);
    const updatedLayout = db.layout.filter(l => (l as LayoutItem).i !== widgetId);

    const all = getAllDashboards();
    const idx = all.findIndex(d => d.id === activeDashboardId);
    if (idx !== -1) {
      all[idx] = { ...all[idx], widgets: updatedWidgets, layout: updatedLayout, updatedAt: Date.now() };
      saveAllDashboards(all);
    }

    set(state => ({
      dashboards: state.dashboards.map(d =>
        d.id === activeDashboardId
          ? { ...d, widgets: updatedWidgets, layout: updatedLayout, updatedAt: Date.now() }
          : d,
      ),
    }));
  },

  updateWidget: (widgetId, updates) => {
    const { activeDashboardId } = get();
    if (!activeDashboardId) return;
    const all = getAllDashboards();
    const idx = all.findIndex(d => d.id === activeDashboardId);
    if (idx !== -1) {
      all[idx].widgets = all[idx].widgets.map(w =>
        w.id === widgetId ? { ...w, ...updates } : w,
      );
      all[idx].updatedAt = Date.now();
      saveAllDashboards(all);
    }
    set(state => ({
      dashboards: state.dashboards.map(d =>
        d.id === activeDashboardId
          ? {
              ...d,
              widgets: d.widgets.map(w => w.id === widgetId ? { ...w, ...updates } : w),
              updatedAt: Date.now(),
            }
          : d,
      ),
    }));
  },

  connectWidgetToStream: (widgetId, streamId) => {
    get().updateWidget(widgetId, { streamId });
  },

  updateLayout: (layout) => {
    const { activeDashboardId } = get();
    if (!activeDashboardId) return;
    const all = getAllDashboards();
    const idx = all.findIndex(d => d.id === activeDashboardId);
    if (idx !== -1) {
      all[idx] = { ...all[idx], layout, updatedAt: Date.now() };
      saveAllDashboards(all);
    }
    set(state => ({
      dashboards: state.dashboards.map(d =>
        d.id === activeDashboardId ? { ...d, layout, updatedAt: Date.now() } : d,
      ),
    }));
  },

  registerStream: (stream) => {
    console.log('[DashboardStore] Registering stream:', stream.id, stream.label);
    const newStream: StreamDefinition = { ...stream, updatedAt: Date.now() };
    const all = getAllStreams();
    const existing = all.findIndex(s => s.id === stream.id);
    if (existing !== -1) {
      all[existing] = newStream;
    } else {
      all.push(newStream);
    }
    saveAllStreams(all);
    set(state => {
      const existing = state.streams.findIndex(s => s.id === stream.id);
      if (existing !== -1) {
        const updated = [...state.streams];
        updated[existing] = newStream;
        return { streams: updated };
      }
      return { streams: [...state.streams, newStream] };
    });
  },

  updateStreamValue: (streamId, value) => {
    set(state => ({
      streams: state.streams.map(s =>
        s.id === streamId ? { ...s, lastValue: value, updatedAt: Date.now() } : s,
      ),
    }));

    fetch(`http://localhost:8080/persist/stream-values/${streamId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastValue: value, updatedAt: new Date().toISOString() }),
    }).catch(() => {});
  },

  getStreamsForProfile: (profileId) => {
    return get().streams.filter(s => s.profileId === profileId);
  },

  publishDashboard: (dashboardId) => {
    const all = getAllDashboards();
    const idx = all.findIndex(d => d.id === dashboardId);
    if (idx !== -1) {
      all[idx] = { ...all[idx], published: true, updatedAt: Date.now() };
      saveAllDashboards(all);
    }
    set(state => ({
      dashboards: state.dashboards.map(d =>
        d.id === dashboardId ? { ...d, published: true, updatedAt: Date.now() } : d,
      ),
    }));
  },

  saveCurrentDashboard: () => {
    const { activeDashboardId, dashboards } = get();
    if (!activeDashboardId) return;
    const db = dashboards.find(d => d.id === activeDashboardId);
    if (!db) return;
    const all = getAllDashboards();
    const idx = all.findIndex(d => d.id === activeDashboardId);
    if (idx !== -1) {
      all[idx] = { ...db, updatedAt: Date.now() };
      saveAllDashboards(all);
    }
  },

  startStreamPolling: () => {
    const poll = async () => {
      try {
        const res = await fetch('http://localhost:8080/persist/stream-values');
        if (res.ok) {
          const allValues: Record<string, { lastValue: unknown; updatedAt: number | string }> = await res.json();
          const streams = get().streams;
          let hasUpdates = false;
          const updatedStreams = streams.map(s => {
            const remoteValue = allValues[s.id];
            if (remoteValue && remoteValue.lastValue !== undefined) {
              if (s.lastValue !== remoteValue.lastValue) {
                hasUpdates = true;
                return {
                  ...s,
                  lastValue: remoteValue.lastValue,
                  updatedAt: typeof remoteValue.updatedAt === 'string' ? new Date(remoteValue.updatedAt).getTime() : remoteValue.updatedAt,
                };
              }
            }
            return s;
          });
          if (hasUpdates) {
            set({ streams: updatedStreams });
            saveAllStreams(updatedStreams);
          }
        }
      } catch (e) {
        console.log('[DashboardStore] Stream polling error:', e);
      }
    };

    poll();
    setInterval(poll, 2000);
  },
}));

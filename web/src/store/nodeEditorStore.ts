import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  MarkerType,
  type Connection,
} from '@xyflow/react';
import { useDashboardStore } from './dashboardStore';

// node category and template Types 
export type NodeCategory =
  | 'input'
  | 'processor'
  | 'output'
  | 'digital-twin';

export interface NodeTemplate {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  icon: string;
  color: string;
  inputs: { id: string; label: string; dataType: string }[];
  outputs: { id: string; label: string; dataType: string }[];
  defaultConfig: Record<string, unknown>;
}

// node templates 
export const NODE_TEMPLATES: NodeTemplate[] = [
  // INPUTS
  {
    type: 'mqtt_subscribe',
    category: 'input',
    label: 'MQTT Subscribe',
    description: 'Subscribe to MQTT topic and receive messages',
    icon: '📡',
    color: '#10b981',
    inputs: [],
    outputs: [
      { id: 'payload', label: 'Payload', dataType: 'json' },
      { id: 'topic', label: 'Topic', dataType: 'string' },
    ],
    defaultConfig: { broker: 'localhost', port: 1883, topic: 'oc4/#', qos: 0 },
  },
  {
    type: 'http_input',
    category: 'input',
    label: 'HTTP Request',
    description: 'Make HTTP requests to external APIs',
    icon: '🌐',
    color: '#0891b2',
    inputs: [],
    outputs: [
      { id: 'response', label: 'Response', dataType: 'json' },
      { id: 'status', label: 'Status', dataType: 'number' },
    ],
    defaultConfig: { url: '', method: 'GET', interval: 5000, headers: {} },
  },
  {
    type: 'simulator',
    category: 'input',
    label: 'Simulator',
    description: 'Generate simulated sensor data',
    icon: '🎲',
    color: '#06b6d4',
    inputs: [],
    outputs: [
      { id: 'data', label: 'Data', dataType: 'json' },
    ],
    defaultConfig: { type: 'sine', frequency: 1, amplitude: 1, noise: 0.1, interval: 100 },
  },
  {
    type: 'websocket_input',
    category: 'input',
    label: 'WebSocket',
    description: 'Receive data from WebSocket connection',
    icon: '🔌',
    color: '#14b8a6',
    inputs: [],
    outputs: [
      { id: 'data', label: 'Data', dataType: 'json' },
    ],
    defaultConfig: { url: 'ws://localhost:8080/ws/realtime', reconnect: true },
  },
  {
    type: 'timer_trigger',
    category: 'input',
    label: 'Timer Trigger',
    description: 'Trigger at regular intervals',
    icon: '⏱️',
    color: '#64748b',
    inputs: [],
    outputs: [
      { id: 'tick', label: 'Tick', dataType: 'number' },
    ],
    defaultConfig: { interval: 1000, autoStart: true },
  },
  {
    type: 'file_reader',
    category: 'input',
    label: 'File Reader',
    description: 'Read data from any local file',
    icon: '📁',
    color: '#0284c7',
    inputs: [],
    outputs: [
      { id: 'file_data', label: 'File Data', dataType: 'any' },
      { id: 'file_name', label: 'File Name', dataType: 'string' },
    ],
    defaultConfig: { uploadedFile: '', readAs: 'arrayBuffer', loop: false },
  },
  {
    type: 'camera_input',
    category: 'input',
    label: 'Camera',
    description: 'Capture frames from a local webcam or camera',
    icon: '📷',
    color: '#7c3aed',
    inputs: [],
    outputs: [
      { id: 'file_data', label: 'Frame', dataType: 'image' },
      { id: 'file_name', label: 'Camera ID', dataType: 'string' },
      { id: 'frame_info', label: 'Frame Info', dataType: 'json' },
    ],
    defaultConfig: { cameraIndex: 0 },
  },

  // PROCESSORS
  {
    type: 'js_script',
    category: 'processor',
    label: 'Script (JS)',
    description: 'Transform data with JavaScript (sandboxed)',
    icon: '⚡',
    color: '#eab308',
    inputs: [{ id: 'input', label: 'Input', dataType: 'any' }],
    outputs: [{ id: 'output', label: 'Output', dataType: 'any' }],
    defaultConfig: { code: '// Transform\nreturn msg;' },
  },
  {
    type: 'ai_inference',
    category: 'processor',
    label: 'AI Inference',
    description: 'Run ML model inference (YOLO, custom)',
    icon: '🤖',
    color: '#7c3aed',
    inputs: [
      { id: 'data', label: 'Data', dataType: 'any' },
      { id: 'config', label: 'Config', dataType: 'json' },
    ],
    outputs: [
      { id: 'predictions', label: 'Predictions', dataType: 'json' },
      { id: 'confidence', label: 'Confidence', dataType: 'number' },
    ],
    defaultConfig: { model: 'yolo11m-pose.pt', confidence: 0.5, device: 'cuda' },
  },
  {
    type: 'filter',
    category: 'processor',
    label: 'Filter',
    description: 'Filter data based on conditions',
    icon: '🔍',
    color: '#a855f7',
    inputs: [{ id: 'input', label: 'Input', dataType: 'any' }],
    outputs: [
      { id: 'pass', label: 'Pass', dataType: 'any' },
      { id: 'reject', label: 'Reject', dataType: 'any' },
    ],
    defaultConfig: { condition: 'value > 0', field: 'data' },
  },
  {
    type: 'fem_analysis',
    category: 'processor',
    label: 'FEM Analysis',
    description: 'Structural Finite Element solver (OpenSees/Abaqus)',
    icon: '🏗️',
    color: '#dc2626',
    inputs: [
      { id: 'loads', label: 'Loads (N, Nm)', dataType: 'json' },
      { id: 'geometry', label: 'Mesh/Config', dataType: 'json' },
    ],
    outputs: [
      { id: 'stress', label: 'Stress (MPa)', dataType: 'json' },
      { id: 'displacement', label: 'Displacement (mm)', dataType: 'json' },
    ],
    defaultConfig: { solver: 'OpenSees', maxIterations: 100, tolerance: 0.001 },
  },
  {
    type: 'onnx_inference',
    category: 'processor',
    label: 'AI Inference',
    description: 'Run deep learning models with keypoint output',
    icon: '🧠',
    color: '#8b5cf6',
    inputs: [
      { id: 'input_data', label: 'Input Data (File)', dataType: 'any' },
    ],
    outputs: [
      { id: 'keypoints', label: 'Keypoints (x,y)', dataType: 'json' },
      { id: 'bounding_boxes', label: 'BBoxes', dataType: 'json' },
      { id: 'confidence', label: 'Confidence Score', dataType: 'number' },
      { id: 'labels', label: 'Class Labels', dataType: 'json' },
      { id: 'raw_tensor', label: 'Raw Output Tensor', dataType: 'any' },
    ],
    defaultConfig: { modelFile: '', device: 'cuda', confidenceThreshold: 0.5 },
  },
  {
    type: 'signal_smoothing',
    category: 'processor',
    label: 'Signal Smoothing',
    description: 'Apply noise-reduction filters',
    icon: '〰️',
    color: '#0891b2',
    inputs: [
      { id: 'signalIn', label: 'Raw Signal', dataType: 'number' },
    ],
    outputs: [
      { id: 'signalOut', label: 'Smoothed Signal', dataType: 'number' },
    ],
    defaultConfig: { filterType: 'kalman', window: 5, q: 1e-5, r: 0.1 },
  },
  {
    type: 'anomaly_detector',
    category: 'processor',
    label: 'Anomaly Detection',
    description: 'Detect outliers using Z-Score, IF, or SVM',
    icon: '🚨',
    color: '#f97316',
    inputs: [
      { id: 'dataStream', label: 'Stream', dataType: 'number' },
    ],
    outputs: [
      { id: 'isAnomaly', label: 'Is Anomaly', dataType: 'boolean' },
      { id: 'score', label: 'Anomaly Score', dataType: 'number' },
    ],
    defaultConfig: { algorithm: 'isolation_forest', contamination: 0.05 },
  },
  {
    type: 'math',
    category: 'processor',
    label: 'Math Operation',
    description: 'Apply mathematical operations',
    icon: '📐',
    color: '#3b82f6',
    inputs: [{ id: 'input', label: 'Input', dataType: 'number' }],
    outputs: [{ id: 'result', label: 'Result', dataType: 'number' }],
    defaultConfig: { operation: 'multiply', operand: 1.0 },
  },
  {
    type: 'time_series',
    category: 'processor',
    label: 'Time-Series Buffer',
    description: 'Buffer and aggregate time-series data',
    icon: '📈',
    color: '#6366f1',
    inputs: [{ id: 'value', label: 'Value', dataType: 'number' }],
    outputs: [
      { id: 'series', label: 'Series', dataType: 'json' },
      { id: 'stats', label: 'Stats', dataType: 'json' },
    ],
    defaultConfig: { windowSize: 100, aggregation: 'avg' },
  },
  {
    type: 'switch',
    category: 'processor',
    label: 'Switch',
    description: 'Route data based on conditions',
    icon: '🔀',
    color: '#475569',
    inputs: [{ id: 'input', label: 'Input', dataType: 'any' }],
    outputs: [
      { id: 'route_a', label: 'Route A', dataType: 'any' },
      { id: 'route_b', label: 'Route B', dataType: 'any' },
      { id: 'default', label: 'Default', dataType: 'any' },
    ],
    defaultConfig: { rules: [{ field: 'type', operator: '==', value: 'alert', output: 0 }] },
  },
  {
    type: 'json_parser',
    category: 'processor',
    label: 'JSON Parser',
    description: 'Parse and extract fields from JSON',
    icon: '📋',
    color: '#2563eb',
    inputs: [{ id: 'raw', label: 'Raw', dataType: 'string' }],
    outputs: [{ id: 'parsed', label: 'Parsed', dataType: 'json' }],
    defaultConfig: { extractPath: '' },
  },

  // OUTPUTS
  {
    type: 'mqtt_publish',
    category: 'output',
    label: 'MQTT Publish',
    description: 'Publish messages to MQTT topic',
    icon: '📤',
    color: '#059669',
    inputs: [{ id: 'payload', label: 'Payload', dataType: 'json' }],
    outputs: [{ id: 'status', label: 'Status', dataType: 'string' }],
    defaultConfig: { broker: 'localhost', port: 1883, topic: 'oc4/command', qos: 1 },
  },
  {
    type: 'dashboard_stream',
    category: 'output',
    label: 'Dashboard Stream',
    description: 'Push data to dashboard widgets',
    icon: '📊',
    color: '#ec4899',
    inputs: [{ id: 'data', label: 'Data', dataType: 'any' }],
    outputs: [],
    defaultConfig: { streamId: '', streamLabel: 'Sensor Data', type: 'timeseries' },
  },
  {
    type: 'number_viewer',
    category: 'output',
    label: 'Number Viewer',
    description: 'Show numeric outputs in dashboard KPI or gauge widgets',
    icon: '🔢',
    color: '#a855f7',
    inputs: [{ id: 'value', label: 'Value', dataType: 'number' }],
    outputs: [],
    defaultConfig: { streamId: '', streamLabel: 'Numeric Value', type: 'snapshot' },
  },
  {
    type: 'save_db',
    category: 'output',
    label: 'Save to DB',
    description: 'Persist data to database',
    icon: '💾',
    color: '#0d9488',
    inputs: [{ id: 'data', label: 'Data', dataType: 'json' }],
    outputs: [{ id: 'status', label: 'Status', dataType: 'string' }],
    defaultConfig: { collection: 'telemetry', ttl: 86400 },
  },
  {
    type: 'alert',
    category: 'output',
    label: 'Alert',
    description: 'Generate alerts and notifications',
    icon: '🔔',
    color: '#ef4444',
    inputs: [{ id: 'trigger', label: 'Trigger', dataType: 'any' }],
    outputs: [],
    defaultConfig: { severity: 'warning', channel: 'ui', message: 'Alert triggered' },
  },
  {
    type: 'webhook',
    category: 'output',
    label: 'Webhook',
    description: 'Send data to external webhook',
    icon: '🔗',
    color: '#f97316',
    inputs: [{ id: 'payload', label: 'Payload', dataType: 'json' }],
    outputs: [{ id: 'response', label: 'Response', dataType: 'json' }],
    defaultConfig: { url: '', method: 'POST', headers: {} },
  },
  {
    type: 'debug',
    category: 'output',
    label: 'Debug Console',
    description: 'Display data for debugging',
    icon: '🐛',
    color: '#94a3b8',
    inputs: [{ id: 'input', label: 'Input', dataType: 'any' }],
    outputs: [],
    defaultConfig: { showTimestamp: true, maxMessages: 50 },
  },
  {
    type: 'terminal_output',
    category: 'output',
    label: 'Terminal Output',
    description: 'Live terminal display — shows incoming data as scrolling text. Connect after MQTT Subscribe for real-time message viewing.',
    icon: '🖥️',
    color: '#22d3ee',
    inputs: [{ id: 'input', label: 'Input', dataType: 'any' }],
    outputs: [],
    defaultConfig: { label: 'Terminal', showTimestamp: true, maxMessages: 100, pollInterval: 1000 },
  },

  // DIGITAL TWIN
  {
    type: '3d_transformer',
    category: 'digital-twin',
    label: '3D Model Transformer',
    description: 'Apply transformations to 3D digital twin model',
    icon: '🎨',
    color: '#f97316',
    inputs: [
      { id: 'pose', label: 'Pose Data', dataType: 'json' },
      { id: 'config', label: 'Config', dataType: 'json' },
    ],
    outputs: [
      { id: 'transform', label: 'Transform', dataType: 'json' },
      { id: 'mesh', label: 'Mesh', dataType: 'mesh' },
    ],
    defaultConfig: { scenePath: 'OC4_Semi.blend', engine: 'THREE', scale: 1.0 },
  },
  {
    type: 'physics_sim',
    category: 'digital-twin',
    label: 'Physics Simulator',
    description: 'Simulate structural physics and forces',
    icon: '⚙️',
    color: '#ea580c',
    inputs: [
      { id: 'state', label: 'Platform State', dataType: 'json' },
      { id: 'env', label: 'Environment', dataType: 'json' },
    ],
    outputs: [
      { id: 'forces', label: 'Forces', dataType: 'json' },
      { id: 'stress', label: 'Stress', dataType: 'json' },
    ],
    defaultConfig: { model: 'oc4_fowt', dt: 0.01, damping: 0.05 },
  },
  {
    type: 'predictive_maintenance',
    category: 'digital-twin',
    label: 'Predictive Maintenance',
    description: 'Estimate remaining useful life',
    icon: '🔧',
    color: '#d946ef',
    inputs: [{ id: 'telemetry', label: 'Telemetry', dataType: 'json' }],
    outputs: [
      { id: 'rul', label: 'RUL', dataType: 'json' },
      { id: 'alerts', label: 'Alerts', dataType: 'json' },
    ],
    defaultConfig: { sn_curve: 'DNV-E', design_life_years: 25 },
  },
  {
    type: 'anomaly_detection',
    category: 'digital-twin',
    label: 'Anomaly Detection',
    description: 'Detect anomalies in sensor data',
    icon: '🚨',
    color: '#dc2626',
    inputs: [{ id: 'data', label: 'Data', dataType: 'json' }],
    outputs: [
      { id: 'result', label: 'Result', dataType: 'json' },
      { id: 'anomalies', label: 'Anomalies', dataType: 'json' },
    ],
    defaultConfig: { method: 'zscore', threshold: 3.0, window: 50 },
  },
  {
    type: 'signal_processor',
    category: 'digital-twin',
    label: 'Signal Processor',
    description: 'FFT, filtering, smoothing for signals',
    icon: '📶',
    color: '#2563eb',
    inputs: [{ id: 'signal', label: 'Signal', dataType: 'signal' }],
    outputs: [
      { id: 'processed', label: 'Processed', dataType: 'signal' },
      { id: 'spectrum', label: 'Spectrum', dataType: 'json' },
    ],
    defaultConfig: { operation: 'lowpass', cutoffFreq: 10, sampleRate: 100 },
  },
];

export const CATEGORY_META: Record<NodeCategory, { label: string; color: string; icon: string }> = {
  input: { label: 'Inputs', color: '#10b981', icon: '📥' },
  processor: { label: 'Processors', color: '#3b82f6', icon: '⚡' },
  output: { label: 'Outputs', color: '#ec4899', icon: '📤' },
  'digital-twin': { label: 'Digital Twin', color: '#f97316', icon: '🔧' },
};

// flow (Pipeline) definition 
export interface Flow {
  id: string;
  userId: string;
  profileId: string;
  name: string;
  description: string;
  nodes: Node[];
  edges: Edge[];
  deployed: boolean;
  createdAt: number;
  updatedAt: number;
}

// store 
export interface NodeEditorStore {
  flows: Flow[];
  activeFlowId: string | null;

  // React Flow state
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;

  // Actions
  loadFlows: (userId: string, profileId: string) => void;
  createFlow: (userId: string, profileId: string, name: string, description: string) => Flow;
  deleteFlow: (flowId: string) => void;
  duplicateFlow: (flowId: string) => Flow | null;
  setActiveFlow: (flowId: string | null) => void;
  updateFlowMeta: (flowId: string, updates: Partial<Pick<Flow, 'name' | 'description'>>) => void;

  // React Flow callbacks
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // Node actions
  addNodeFromTemplate: (template: NodeTemplate, position: { x: number; y: number }) => void;
  removeSelectedNode: () => void;
  selectNode: (nodeId: string | null) => void;
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void;

  // Persistence
  saveCurrentFlow: () => void;
  deployFlow: (flowId: string) => void;
}

const FLOWS_KEY = 'oc4_dt_flows';

function getAllFlows(): Flow[] {
  try {
    const raw = localStorage.getItem(FLOWS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAllFlows(flows: Flow[]) {
  localStorage.setItem(FLOWS_KEY, JSON.stringify(flows));
  fetch('http://localhost:8080/persist/flows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flows),
  }).catch(() => {});
}

export const useNodeEditorStore = create<NodeEditorStore>((set, get) => ({
  flows: [],
  activeFlowId: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,

  loadFlows: async (userId: string, profileId: string) => {
    try {
      const res = await fetch('http://localhost:8080/persist/flows');
      if (res.ok) {
        const backendFlows = await res.json();
        if (backendFlows && Array.isArray(backendFlows) && backendFlows.length > 0) {
          localStorage.setItem(FLOWS_KEY, JSON.stringify(backendFlows));
        }
      }
    } catch {
      // fallback to local
    }
    const all = getAllFlows();
    const filtered = all.filter(f => f.userId === userId && f.profileId === profileId);
    set({ flows: filtered });
  },

  createFlow: (userId, profileId, name, description) => {
    const flow: Flow = {
      id: uuidv4(),
      userId,
      profileId,
      name,
      description,
      nodes: [],
      edges: [],
      deployed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const all = getAllFlows();
    all.push(flow);
    saveAllFlows(all);
    set(state => ({
      flows: [...state.flows, flow],
      activeFlowId: flow.id,
      nodes: [],
      edges: [],
      selectedNodeId: null,
    }));
    return flow;
  },

  deleteFlow: (flowId) => {
    const all = getAllFlows().filter(f => f.id !== flowId);
    saveAllFlows(all);
    const state = get();
    set({
      flows: state.flows.filter(f => f.id !== flowId),
      activeFlowId: state.activeFlowId === flowId ? null : state.activeFlowId,
      nodes: state.activeFlowId === flowId ? [] : state.nodes,
      edges: state.activeFlowId === flowId ? [] : state.edges,
      selectedNodeId: null,
    });
  },

  duplicateFlow: (flowId) => {
    const flow = get().flows.find(f => f.id === flowId);
    if (!flow) return null;
    const dup: Flow = {
      ...flow,
      id: uuidv4(),
      name: `${flow.name} (Copy)`,
      nodes: flow.nodes.map(n => ({ ...n, id: uuidv4() })),
      edges: [],
      deployed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const all = getAllFlows();
    all.push(dup);
    saveAllFlows(all);
    set(state => ({ flows: [...state.flows, dup] }));
    return dup;
  },

  setActiveFlow: (flowId) => {
    if (!flowId) {
      set({ activeFlowId: null, nodes: [], edges: [], selectedNodeId: null });
      return;
    }
    const flow = get().flows.find(f => f.id === flowId);
    if (flow) {
      set({
        activeFlowId: flowId,
        nodes: flow.nodes || [],
        edges: flow.edges || [],
        selectedNodeId: null,
      });
    }
  },

  updateFlowMeta: (flowId, updates) => {
    const all = getAllFlows();
    const idx = all.findIndex(f => f.id === flowId);
    if (idx === -1) return;
    all[idx] = { ...all[idx], ...updates, updatedAt: Date.now() };
    saveAllFlows(all);
    set(state => ({
      flows: state.flows.map(f => f.id === flowId ? { ...f, ...updates, updatedAt: Date.now() } : f),
    }));
  },

  // React Flow handlers
  onNodesChange: (changes) => {
    set(state => ({
      nodes: applyNodeChanges(changes, state.nodes),
    }));
    // Auto-save on changes (debounced later)
    setTimeout(() => get().saveCurrentFlow(), 300);
  },

  onEdgesChange: (changes) => {
    set(state => ({
      edges: applyEdgeChanges(changes, state.edges),
    }));
    setTimeout(() => get().saveCurrentFlow(), 300);
  },

  onConnect: (connection: Connection) => {
    set(state => ({
      edges: addEdge(
        {
          ...connection,
          type: 'smoothstep',
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          style: { strokeWidth: 2 },
        },
        state.edges,
      ),
    }));
    setTimeout(() => get().saveCurrentFlow(), 300);
  },

  addNodeFromTemplate: (template, position) => {
    const nodeId = uuidv4();
    const streamId = template.type === 'dashboard_stream' ? uuidv4() : undefined;
    // Use the dedicated terminal renderer for terminal_output nodes
    const reactFlowType = template.type === 'terminal_output' ? 'terminal' : 'custom';
    const newNode: Node = {
      id: nodeId,
      type: reactFlowType,
      position,
      data: {
        type: template.type,
        category: template.category,
        label: template.label,
        icon: template.icon,
        color: template.color,
        inputs: template.inputs,
        outputs: template.outputs,
        config: {
          ...template.defaultConfig,
          ...(streamId ? { streamId } : {}),
        },
      },
    };
    set(state => ({
      nodes: [...state.nodes, newNode],
    }));
    setTimeout(() => get().saveCurrentFlow(), 300);
  },

  removeSelectedNode: () => {
    const { selectedNodeId, nodes, edges } = get();
    if (!selectedNodeId) return;
    set({
      nodes: nodes.filter(n => n.id !== selectedNodeId),
      edges: edges.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId),
      selectedNodeId: null,
    });
    setTimeout(() => get().saveCurrentFlow(), 300);
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  updateNodeConfig: (nodeId, config) => {
    set(state => ({
      nodes: state.nodes.map(n =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, config: { ...(n.data.config as Record<string, unknown>), ...config } } }
          : n,
      ),
    }));
    setTimeout(() => get().saveCurrentFlow(), 300);
  },

  saveCurrentFlow: () => {
    const { activeFlowId, nodes, edges } = get();
    if (!activeFlowId) return;
    const all = getAllFlows();
    const idx = all.findIndex(f => f.id === activeFlowId);
    if (idx === -1) return;
    all[idx] = { ...all[idx], nodes, edges, updatedAt: Date.now() };
    saveAllFlows(all);
    set(state => ({
      flows: state.flows.map(f =>
        f.id === activeFlowId ? { ...f, nodes, edges, updatedAt: Date.now() } : f,
      ),
    }));
  },

  deployFlow: (flowId) => {
    const all = getAllFlows();
    const idx = all.findIndex(f => f.id === flowId);
    if (idx === -1) return;
    
    const flow = all[idx];
    all[idx] = { ...flow, deployed: true, updatedAt: Date.now() };
    saveAllFlows(all);
    
    // Register output streams in dashboardStore
    const dashboardStreams = flow.nodes.filter(
      n => n.data.type === 'dashboard_stream' || n.data.type === 'number_viewer',
    );
    console.log('[NodeEditorStore] Found', dashboardStreams.length, 'dashboard streams to register');
    const { registerStream } = useDashboardStore.getState();
    
    dashboardStreams.forEach(node => {
      const config = node.data.config as any;
      console.log('[NodeEditorStore] Processing stream node:', {
        nodeId: node.id,
        streamId: config.streamId,
        streamLabel: config.streamLabel,
        flowProfileId: flow.profileId,
        flowId: flow.id
      });
      if (config.streamId) {
        registerStream({
          id: config.streamId,
          profileId: flow.profileId,
          flowId: flow.id,
          nodeId: node.id,
          label: config.streamLabel || 'Untitled Stream',
          type: config.type || 'timeseries',
          lastValue: null
        });
      }
    });

    set(state => ({
      flows: state.flows.map(f =>
        f.id === flowId ? { ...f, deployed: true, updatedAt: Date.now() } : f,
      ),
    }));

    fetch('http://localhost:8080/api/flow/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flowId: flow.id,
        flow: {
          id: flow.id,
          nodes: flow.nodes,
          edges: flow.edges
        },
        config: { interval: 0.1 }
      }),
    })
    .then(res => res.json())
    .then(data => console.log('[NodeEditorStore] Flow deployed:', data))
    .catch(err => console.error('[NodeEditorStore] Flow deploy error:', err));

    fetch('http://localhost:8080/persist/deployed_flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all.filter(f => f.deployed)),
    }).catch(() => {});
  },
}));

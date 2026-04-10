import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

// ========== Node Type Definitions ==========
export type NodeCategory = 'data' | 'processing' | 'communication' | 'visualization' | 'ai' | 'control';

export interface NodePort {
    id: string;
    label: string;
    type: 'input' | 'output';
    dataType: 'any' | 'number' | 'string' | 'json' | 'image' | 'mesh' | 'signal';
    connected: boolean;
}

export interface PipelineNode {
    id: string;
    type: string;
    category: NodeCategory;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    inputs: NodePort[];
    outputs: NodePort[];
    config: Record<string, unknown>;
    color: string;
    icon: string;
}

export interface PipelineConnection {
    id: string;
    fromNodeId: string;
    fromPortId: string;
    toNodeId: string;
    toPortId: string;
}

export interface Pipeline {
    id: string;
    userId: string;
    profileId: string | null;
    name: string;
    description: string;
    nodes: PipelineNode[];
    connections: PipelineConnection[];
    createdAt: number;
    updatedAt: number;
}

// ========== Node Templates ==========
export interface NodeTemplate {
    type: string;
    category: NodeCategory;
    label: string;
    description: string;
    icon: string;
    color: string;
    defaultWidth: number;
    defaultHeight: number;
    inputs: Omit<NodePort, 'id' | 'connected'>[];
    outputs: Omit<NodePort, 'id' | 'connected'>[];
    defaultConfig: Record<string, unknown>;
}

export const NODE_TEMPLATES: NodeTemplate[] = [
    // DATA nodes
    {
        type: 'mqtt_subscriber',
        category: 'communication',
        label: 'MQTT Subscriber',
        description: 'Subscribe to an MQTT topic and receive messages',
        icon: '📡',
        color: '#10b981',
        defaultWidth: 220,
        defaultHeight: 120,
        inputs: [],
        outputs: [
            { label: 'Message', type: 'output', dataType: 'json' },
            { label: 'Topic', type: 'output', dataType: 'string' },
        ],
        defaultConfig: { broker: 'localhost', port: 1883, topic: 'oc4/#', qos: 0 },
    },
    {
        type: 'mqtt_publisher',
        category: 'communication',
        label: 'MQTT Publisher',
        description: 'Publish messages to an MQTT topic',
        icon: '📤',
        color: '#059669',
        defaultWidth: 220,
        defaultHeight: 120,
        inputs: [
            { label: 'Payload', type: 'input', dataType: 'json' },
        ],
        outputs: [
            { label: 'Status', type: 'output', dataType: 'string' },
        ],
        defaultConfig: { broker: 'localhost', port: 1883, topic: 'oc4/command', qos: 1 },
    },
    {
        type: 'websocket_input',
        category: 'communication',
        label: 'WebSocket Input',
        description: 'Receive data from a WebSocket connection',
        icon: '🔌',
        color: '#0891b2',
        defaultWidth: 220,
        defaultHeight: 110,
        inputs: [],
        outputs: [
            { label: 'Data', type: 'output', dataType: 'json' },
        ],
        defaultConfig: { url: 'ws://localhost:8080/ws/realtime', reconnect: true },
    },
    // CODE nodes
    {
        type: 'python_script',
        category: 'processing',
        label: 'Python Script',
        description: 'Execute a Python script to process data',
        icon: '🐍',
        color: '#3b82f6',
        defaultWidth: 240,
        defaultHeight: 140,
        inputs: [
            { label: 'Input', type: 'input', dataType: 'any' },
        ],
        outputs: [
            { label: 'Output', type: 'output', dataType: 'any' },
            { label: 'Logs', type: 'output', dataType: 'string' },
        ],
        defaultConfig: { script: '# Write your Python code here\nresult = input_data', filename: 'process.py' },
    },
    {
        type: 'javascript_function',
        category: 'processing',
        label: 'JavaScript Function',
        description: 'Transform data with a JavaScript function',
        icon: '⚡',
        color: '#eab308',
        defaultWidth: 240,
        defaultHeight: 130,
        inputs: [
            { label: 'Input', type: 'input', dataType: 'any' },
        ],
        outputs: [
            { label: 'Output', type: 'output', dataType: 'any' },
        ],
        defaultConfig: { code: '// Transform the input\nreturn msg;' },
    },
    {
        type: 'json_parser',
        category: 'processing',
        label: 'JSON Parser',
        description: 'Parse and extract fields from JSON data',
        icon: '📋',
        color: '#6366f1',
        defaultWidth: 200,
        defaultHeight: 110,
        inputs: [
            { label: 'Raw JSON', type: 'input', dataType: 'string' },
        ],
        outputs: [
            { label: 'Parsed', type: 'output', dataType: 'json' },
        ],
        defaultConfig: { extractPath: '' },
    },
    {
        type: 'filter_node',
        category: 'processing',
        label: 'Data Filter',
        description: 'Filter data based on conditions',
        icon: '🔍',
        color: '#a855f7',
        defaultWidth: 200,
        defaultHeight: 120,
        inputs: [
            { label: 'Input', type: 'input', dataType: 'any' },
        ],
        outputs: [
            { label: 'Pass', type: 'output', dataType: 'any' },
            { label: 'Reject', type: 'output', dataType: 'any' },
        ],
        defaultConfig: { condition: 'value > 0', field: 'data' },
    },
    // BLENDER nodes
    {
        type: 'blender_scene',
        category: 'visualization',
        label: 'Blender Scene',
        description: 'Load and configure a Blender 3D scene',
        icon: '🎨',
        color: '#f97316',
        defaultWidth: 240,
        defaultHeight: 140,
        inputs: [
            { label: 'Pose Data', type: 'input', dataType: 'json' },
            { label: 'Config', type: 'input', dataType: 'json' },
        ],
        outputs: [
            { label: 'Render', type: 'output', dataType: 'image' },
            { label: 'Mesh', type: 'output', dataType: 'mesh' },
        ],
        defaultConfig: { scenePath: 'OC4_Semi.blend', engine: 'EEVEE', resolution: [1920, 1080] },
    },
    {
        type: 'blender_animation',
        category: 'visualization',
        label: 'Blender Animation',
        description: 'Animate objects in Blender based on input data',
        icon: '🎬',
        color: '#ea580c',
        defaultWidth: 230,
        defaultHeight: 130,
        inputs: [
            { label: 'Keyframes', type: 'input', dataType: 'json' },
            { label: 'Scene', type: 'input', dataType: 'mesh' },
        ],
        outputs: [
            { label: 'Animation', type: 'output', dataType: 'mesh' },
        ],
        defaultConfig: { fps: 30, interpolation: 'linear', loop: false },
    },
    // RENDERING nodes
    {
        type: 'render_3d',
        category: 'visualization',
        label: '3D Renderer',
        description: 'Render a 3D scene using Three.js / WebGL',
        icon: '🖥️',
        color: '#ec4899',
        defaultWidth: 230,
        defaultHeight: 130,
        inputs: [
            { label: 'Mesh', type: 'input', dataType: 'mesh' },
            { label: 'Camera', type: 'input', dataType: 'json' },
        ],
        outputs: [
            { label: 'Frame', type: 'output', dataType: 'image' },
        ],
        defaultConfig: { renderer: 'webgl', antialiasing: true, shadows: true },
    },
    {
        type: 'chart_renderer',
        category: 'visualization',
        label: 'Chart Renderer',
        description: 'Render real-time charts from data streams',
        icon: '📊',
        color: '#d946ef',
        defaultWidth: 220,
        defaultHeight: 120,
        inputs: [
            { label: 'Data Series', type: 'input', dataType: 'json' },
        ],
        outputs: [
            { label: 'Chart Image', type: 'output', dataType: 'image' },
        ],
        defaultConfig: { chartType: 'line', maxPoints: 100, realtime: true },
    },
    // DATASET nodes
    {
        type: 'dataset_loader',
        category: 'data',
        label: 'Dataset Loader',
        description: 'Load a dataset from file or API',
        icon: '📂',
        color: '#14b8a6',
        defaultWidth: 220,
        defaultHeight: 120,
        inputs: [],
        outputs: [
            { label: 'Data', type: 'output', dataType: 'json' },
            { label: 'Metadata', type: 'output', dataType: 'json' },
        ],
        defaultConfig: { source: 'file', path: '/data/dataset.csv', format: 'csv' },
    },
    {
        type: 'dataset_writer',
        category: 'data',
        label: 'Dataset Writer',
        description: 'Save processed data to a dataset file',
        icon: '💾',
        color: '#0d9488',
        defaultWidth: 220,
        defaultHeight: 120,
        inputs: [
            { label: 'Data', type: 'input', dataType: 'json' },
        ],
        outputs: [
            { label: 'Status', type: 'output', dataType: 'string' },
        ],
        defaultConfig: { path: '/output/result.csv', format: 'csv', append: false },
    },
    {
        type: 'synthetic_generator',
        category: 'data',
        label: 'Synthetic Data Gen',
        description: 'Generate synthetic data for training models',
        icon: '🧪',
        color: '#2dd4bf',
        defaultWidth: 230,
        defaultHeight: 130,
        inputs: [
            { label: 'Config', type: 'input', dataType: 'json' },
        ],
        outputs: [
            { label: 'Samples', type: 'output', dataType: 'json' },
            { label: 'Labels', type: 'output', dataType: 'json' },
        ],
        defaultConfig: { numSamples: 1000, randomSeed: 42, augmentation: true },
    },
    // AI nodes
    {
        type: 'yolo_inference',
        category: 'ai',
        label: 'YOLO Inference',
        description: 'Run YOLO model for object/pose detection',
        icon: '🤖',
        color: '#7c3aed',
        defaultWidth: 230,
        defaultHeight: 140,
        inputs: [
            { label: 'Image', type: 'input', dataType: 'image' },
            { label: 'Config', type: 'input', dataType: 'json' },
        ],
        outputs: [
            { label: 'Detections', type: 'output', dataType: 'json' },
            { label: 'Annotated', type: 'output', dataType: 'image' },
        ],
        defaultConfig: { model: 'yolo11m-pose.pt', confidence: 0.5, device: 'cuda' },
    },
    {
        type: 'signal_processor',
        category: 'processing',
        label: 'Signal Processor',
        description: 'Apply DSP operations: FFT, filtering, smoothing',
        icon: '📶',
        color: '#2563eb',
        defaultWidth: 220,
        defaultHeight: 130,
        inputs: [
            { label: 'Signal', type: 'input', dataType: 'signal' },
        ],
        outputs: [
            { label: 'Processed', type: 'output', dataType: 'signal' },
            { label: 'Spectrum', type: 'output', dataType: 'json' },
        ],
        defaultConfig: { operation: 'lowpass', cutoffFreq: 10, sampleRate: 100 },
    },
    // CONTROL nodes
    {
        type: 'timer_trigger',
        category: 'control',
        label: 'Timer Trigger',
        description: 'Trigger pipeline execution at intervals',
        icon: '⏱️',
        color: '#64748b',
        defaultWidth: 180,
        defaultHeight: 100,
        inputs: [],
        outputs: [
            { label: 'Tick', type: 'output', dataType: 'number' },
        ],
        defaultConfig: { interval: 1000, autoStart: true },
    },
    {
        type: 'switch_node',
        category: 'control',
        label: 'Switch / Router',
        description: 'Route data to different outputs based on conditions',
        icon: '🔀',
        color: '#475569',
        defaultWidth: 200,
        defaultHeight: 130,
        inputs: [
            { label: 'Input', type: 'input', dataType: 'any' },
        ],
        outputs: [
            { label: 'Route A', type: 'output', dataType: 'any' },
            { label: 'Route B', type: 'output', dataType: 'any' },
            { label: 'Default', type: 'output', dataType: 'any' },
        ],
        defaultConfig: { rules: [{ field: 'type', value: 'alert', output: 0 }] },
    },
    {
        type: 'debug_node',
        category: 'control',
        label: 'Debug Console',
        description: 'Display incoming data for debugging',
        icon: '🐛',
        color: '#94a3b8',
        defaultWidth: 180,
        defaultHeight: 100,
        inputs: [
            { label: 'Input', type: 'input', dataType: 'any' },
        ],
        outputs: [],
        defaultConfig: { showTimestamp: true, maxMessages: 50 },
    },
];

// ========== Store ==========
interface PipelineStore {
    pipelines: Pipeline[];
    activePipelineId: string | null;

    // Editing state
    selectedNodeId: string | null;
    connectingFrom: { nodeId: string; portId: string } | null;
    isPanning: boolean;
    panOffset: { x: number; y: number };
    zoom: number;

    // Actions
    loadPipelines: (userId: string) => void;
    createPipeline: (userId: string, profileId: string | null, name: string, description: string) => Pipeline;
    updatePipeline: (pipelineId: string, updates: Partial<Pipeline>) => void;
    deletePipeline: (pipelineId: string) => void;
    setActivePipeline: (pipelineId: string | null) => void;
    duplicatePipeline: (pipelineId: string) => Pipeline | null;

    // Node actions
    addNode: (template: NodeTemplate, x: number, y: number) => void;
    updateNode: (nodeId: string, updates: Partial<PipelineNode>) => void;
    removeNode: (nodeId: string) => void;
    moveNode: (nodeId: string, x: number, y: number) => void;
    selectNode: (nodeId: string | null) => void;

    // Connection actions
    startConnection: (nodeId: string, portId: string) => void;
    completeConnection: (nodeId: string, portId: string) => void;
    cancelConnection: () => void;
    removeConnection: (connectionId: string) => void;

    // Canvas actions
    setPanOffset: (offset: { x: number; y: number }) => void;
    setZoom: (zoom: number) => void;

    // Persistence
    savePipeline: () => void;
}

const PIPELINES_KEY = 'oc4_dt_pipelines';

function getAllPipelines(): Pipeline[] {
    try {
        const raw = localStorage.getItem(PIPELINES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveAllPipelines(pipelines: Pipeline[]) {
    localStorage.setItem(PIPELINES_KEY, JSON.stringify(pipelines));
    fetch('http://localhost:8080/persist/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pipelines)
    }).catch(() => { });
}

export const usePipelineStore = create<PipelineStore>((set, get) => ({
    pipelines: [],
    activePipelineId: null,
    selectedNodeId: null,
    connectingFrom: null,
    isPanning: false,
    panOffset: { x: 0, y: 0 },
    zoom: 1,

    loadPipelines: async (userId: string) => {
        try {
            const res = await fetch('http://localhost:8080/persist/pipelines');
            if (res.ok) {
                const backendPipelines = await res.json();
                if (backendPipelines && Array.isArray(backendPipelines) && backendPipelines.length > 0) {
                    localStorage.setItem(PIPELINES_KEY, JSON.stringify(backendPipelines));
                }
            }
        } catch (e) {
            // Fallback to local
        }

        const all = getAllPipelines();
        set({ pipelines: all.filter(p => p.userId === userId) });
    },

    createPipeline: (userId, profileId, name, description) => {
        const pipeline: Pipeline = {
            id: uuidv4(),
            userId,
            profileId,
            name,
            description,
            nodes: [],
            connections: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        const all = getAllPipelines();
        all.push(pipeline);
        saveAllPipelines(all);

        set(state => ({
            pipelines: [...state.pipelines, pipeline],
            activePipelineId: pipeline.id
        }));
        return pipeline;
    },

    updatePipeline: (pipelineId, updates) => {
        const all = getAllPipelines();
        const idx = all.findIndex(p => p.id === pipelineId);
        if (idx === -1) return;

        all[idx] = { ...all[idx], ...updates, updatedAt: Date.now() };
        saveAllPipelines(all);

        set(state => ({
            pipelines: state.pipelines.map(p =>
                p.id === pipelineId ? { ...p, ...updates, updatedAt: Date.now() } : p
            )
        }));
    },

    deletePipeline: (pipelineId) => {
        const all = getAllPipelines().filter(p => p.id !== pipelineId);
        saveAllPipelines(all);

        set(state => ({
            pipelines: state.pipelines.filter(p => p.id !== pipelineId),
            activePipelineId: state.activePipelineId === pipelineId ? null : state.activePipelineId,
        }));
    },

    setActivePipeline: (pipelineId) => {
        set({ activePipelineId: pipelineId, selectedNodeId: null, connectingFrom: null });
    },

    duplicatePipeline: (pipelineId) => {
        const pipeline = get().pipelines.find(p => p.id === pipelineId);
        if (!pipeline) return null;

        const dup: Pipeline = {
            ...pipeline,
            id: uuidv4(),
            name: `${pipeline.name} (Copy)`,
            nodes: pipeline.nodes.map(n => ({ ...n, id: uuidv4() })),
            connections: [], // connections need to be re-mapped, so clear them for simplicity
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        const all = getAllPipelines();
        all.push(dup);
        saveAllPipelines(all);

        set(state => ({ pipelines: [...state.pipelines, dup] }));
        return dup;
    },

    // Node actions
    addNode: (template, x, y) => {
        const state = get();
        const activePipeline = state.pipelines.find(p => p.id === state.activePipelineId);
        if (!activePipeline) return;

        const node: PipelineNode = {
            id: uuidv4(),
            type: template.type,
            category: template.category,
            label: template.label,
            x,
            y,
            width: template.defaultWidth,
            height: template.defaultHeight,
            inputs: template.inputs.map(inp => ({ ...inp, id: uuidv4(), connected: false })),
            outputs: template.outputs.map(out => ({ ...out, id: uuidv4(), connected: false })),
            config: { ...template.defaultConfig },
            color: template.color,
            icon: template.icon,
        };

        const updatedNodes = [...activePipeline.nodes, node];
        get().updatePipeline(activePipeline.id, { nodes: updatedNodes });
    },

    updateNode: (nodeId, updates) => {
        const state = get();
        const activePipeline = state.pipelines.find(p => p.id === state.activePipelineId);
        if (!activePipeline) return;

        const updatedNodes = activePipeline.nodes.map(n =>
            n.id === nodeId ? { ...n, ...updates } : n
        );
        get().updatePipeline(activePipeline.id, { nodes: updatedNodes });
    },

    removeNode: (nodeId) => {
        const state = get();
        const activePipeline = state.pipelines.find(p => p.id === state.activePipelineId);
        if (!activePipeline) return;

        const updatedNodes = activePipeline.nodes.filter(n => n.id !== nodeId);
        const updatedConnections = activePipeline.connections.filter(
            c => c.fromNodeId !== nodeId && c.toNodeId !== nodeId
        );
        get().updatePipeline(activePipeline.id, { nodes: updatedNodes, connections: updatedConnections });
        if (state.selectedNodeId === nodeId) set({ selectedNodeId: null });
    },

    moveNode: (nodeId, x, y) => {
        const state = get();
        const activePipeline = state.pipelines.find(p => p.id === state.activePipelineId);
        if (!activePipeline) return;

        const updatedNodes = activePipeline.nodes.map(n =>
            n.id === nodeId ? { ...n, x, y } : n
        );
        get().updatePipeline(activePipeline.id, { nodes: updatedNodes });
    },

    selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

    startConnection: (nodeId, portId) => {
        set({ connectingFrom: { nodeId, portId } });
    },

    completeConnection: (nodeId, portId) => {
        const state = get();
        if (!state.connectingFrom) return;
        if (state.connectingFrom.nodeId === nodeId) {
            set({ connectingFrom: null });
            return;
        }

        const activePipeline = state.pipelines.find(p => p.id === state.activePipelineId);
        if (!activePipeline) return;

        // Determine which is output and which is input
        const fromNode = activePipeline.nodes.find(n => n.id === state.connectingFrom!.nodeId);
        const toNode = activePipeline.nodes.find(n => n.id === nodeId);
        if (!fromNode || !toNode) { set({ connectingFrom: null }); return; }

        const fromPort = fromNode.outputs.find(p => p.id === state.connectingFrom!.portId)
            || fromNode.inputs.find(p => p.id === state.connectingFrom!.portId);
        const toPort = toNode.inputs.find(p => p.id === portId)
            || toNode.outputs.find(p => p.id === portId);

        if (!fromPort || !toPort) { set({ connectingFrom: null }); return; }

        // Ensure one is output and one is input
        let finalFrom: { nodeId: string; portId: string };
        let finalTo: { nodeId: string; portId: string };

        if (fromPort.type === 'output' && toPort.type === 'input') {
            finalFrom = { nodeId: state.connectingFrom!.nodeId, portId: state.connectingFrom!.portId };
            finalTo = { nodeId, portId };
        } else if (fromPort.type === 'input' && toPort.type === 'output') {
            finalFrom = { nodeId, portId };
            finalTo = { nodeId: state.connectingFrom!.nodeId, portId: state.connectingFrom!.portId };
        } else {
            set({ connectingFrom: null });
            return;
        }

        // Check for duplicate
        const exists = activePipeline.connections.some(
            c => c.fromNodeId === finalFrom.nodeId && c.fromPortId === finalFrom.portId
                && c.toNodeId === finalTo.nodeId && c.toPortId === finalTo.portId
        );
        if (exists) { set({ connectingFrom: null }); return; }

        const connection: PipelineConnection = {
            id: uuidv4(),
            fromNodeId: finalFrom.nodeId,
            fromPortId: finalFrom.portId,
            toNodeId: finalTo.nodeId,
            toPortId: finalTo.portId,
        };

        const updatedConnections = [...activePipeline.connections, connection];
        get().updatePipeline(activePipeline.id, { connections: updatedConnections });
        set({ connectingFrom: null });
    },

    cancelConnection: () => set({ connectingFrom: null }),

    removeConnection: (connectionId) => {
        const state = get();
        const activePipeline = state.pipelines.find(p => p.id === state.activePipelineId);
        if (!activePipeline) return;

        const updatedConnections = activePipeline.connections.filter(c => c.id !== connectionId);
        get().updatePipeline(activePipeline.id, { connections: updatedConnections });
    },

    setPanOffset: (offset) => set({ panOffset: offset }),
    setZoom: (zoom) => set({ zoom: Math.max(0.2, Math.min(2, zoom)) }),

    savePipeline: () => {
        // Already auto-saved on every change
    },
}));

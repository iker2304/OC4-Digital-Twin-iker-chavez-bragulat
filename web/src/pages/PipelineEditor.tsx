import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuthStore } from '../store/authStore';
import { usePipelineStore, NODE_TEMPLATES, type NodeTemplate, type NodeCategory } from '../store/pipelineStore';
import {
    Plus, Trash2, Play, Square, ChevronDown, Search,
    Maximize2, ZoomIn, ZoomOut, RotateCcw, X, Copy, Edit3,
    Layers, Code, Radio, Paintbrush, Database, Cpu, SlidersHorizontal
} from 'lucide-react';

const CATEGORY_META: Record<NodeCategory, { label: string; icon: React.ReactNode; color: string }> = {
    data: { label: 'Data', icon: <Database className="w-4 h-4" />, color: '#14b8a6' },
    processing: { label: 'Processing', icon: <Code className="w-4 h-4" />, color: '#3b82f6' },
    communication: { label: 'Communication', icon: <Radio className="w-4 h-4" />, color: '#10b981' },
    visualization: { label: 'Visualization', icon: <Paintbrush className="w-4 h-4" />, color: '#ec4899' },
    ai: { label: 'AI / ML', icon: <Cpu className="w-4 h-4" />, color: '#7c3aed' },
    control: { label: 'Control', icon: <SlidersHorizontal className="w-4 h-4" />, color: '#64748b' },
};

export default function PipelineEditor() {
    const { currentUser } = useAuthStore();
    const store = usePipelineStore();
    const {
        pipelines, activePipelineId,
        loadPipelines, createPipeline, deletePipeline, setActivePipeline, duplicatePipeline,
        addNode, removeNode, moveNode, selectNode, selectedNodeId,
        startConnection, completeConnection, cancelConnection, removeConnection,
        connectingFrom, panOffset, setPanOffset, zoom, setZoom,
    } = store;

    const canvasRef = useRef<HTMLDivElement>(null);
    const [showToolbar, setShowToolbar] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedCategory, setExpandedCategory] = useState<NodeCategory | null>(null);
    const [showCreatePipeline, setShowCreatePipeline] = useState(false);
    const [newPipelineName, setNewPipelineName] = useState('');
    const [newPipelineDesc, setNewPipelineDesc] = useState('');
    const [showPipelineList, setShowPipelineList] = useState(false);
    const [isDraggingNode, setIsDraggingNode] = useState<string | null>(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState({ x: 0, y: 0 });
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
    const [showNodeConfig, setShowNodeConfig] = useState(false);

    useEffect(() => {
        if (currentUser) {
            loadPipelines(currentUser.id);
        }
    }, [currentUser, loadPipelines]);

    const activePipeline = pipelines.find(p => p.id === activePipelineId);

    // ========== Canvas Mouse Handlers ==========
    const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button === 1 || (e.button === 0 && e.altKey)) {
            setIsPanning(true);
            setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
            e.preventDefault();
        } else if (e.button === 0 && !(e.target as HTMLElement).closest('.pipeline-node')) {
            selectNode(null);
            cancelConnection();
        }
    }, [panOffset, selectNode, cancelConnection]);

    const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
            setMousePos({
                x: (e.clientX - rect.left - panOffset.x) / zoom,
                y: (e.clientY - rect.top - panOffset.y) / zoom,
            });
        }

        if (isPanning) {
            setPanOffset({
                x: e.clientX - panStart.x,
                y: e.clientY - panStart.y,
            });
        }

        if (isDraggingNode && activePipeline) {
            const x = (e.clientX - (canvasRef.current?.getBoundingClientRect().left || 0) - panOffset.x) / zoom - dragOffset.x;
            const y = (e.clientY - (canvasRef.current?.getBoundingClientRect().top || 0) - panOffset.y) / zoom - dragOffset.y;
            moveNode(isDraggingNode, Math.round(x / 10) * 10, Math.round(y / 10) * 10);
        }
    }, [isPanning, panStart, isDraggingNode, activePipeline, dragOffset, panOffset, zoom, moveNode, setPanOffset]);

    const handleCanvasMouseUp = useCallback(() => {
        setIsPanning(false);
        setIsDraggingNode(null);
    }, []);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setZoom(zoom + delta);
    }, [zoom, setZoom]);

    // ========== Node Interaction ==========
    const handleNodeMouseDown = (nodeId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        selectNode(nodeId);

        const node = activePipeline?.nodes.find(n => n.id === nodeId);
        if (node) {
            const rect = canvasRef.current?.getBoundingClientRect();
            if (rect) {
                const canvasX = (e.clientX - rect.left - panOffset.x) / zoom;
                const canvasY = (e.clientY - rect.top - panOffset.y) / zoom;
                setDragOffset({ x: canvasX - node.x, y: canvasY - node.y });
                setIsDraggingNode(nodeId);
            }
        }
    };

    const handlePortClick = (nodeId: string, portId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (connectingFrom) {
            completeConnection(nodeId, portId);
        } else {
            startConnection(nodeId, portId);
        }
    };

    // ========== Drop Handler for Toolbar ==========
    const handleTemplateDrop = (template: NodeTemplate, e: React.DragEvent) => {
        e.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect || !activePipeline) return;

        const x = (e.clientX - rect.left - panOffset.x) / zoom - template.defaultWidth / 2;
        const y = (e.clientY - rect.top - panOffset.y) / zoom - template.defaultHeight / 2;
        addNode(template, Math.round(x / 10) * 10, Math.round(y / 10) * 10);
    };

    // ========== Render Connection Lines ==========
    const renderConnections = () => {
        if (!activePipeline) return null;

        return activePipeline.connections.map(conn => {
            const fromNode = activePipeline.nodes.find(n => n.id === conn.fromNodeId);
            const toNode = activePipeline.nodes.find(n => n.id === conn.toNodeId);
            if (!fromNode || !toNode) return null;

            const fromPort = fromNode.outputs.find(p => p.id === conn.fromPortId);
            const toPort = toNode.inputs.find(p => p.id === conn.toPortId);
            if (!fromPort || !toPort) return null;

            const fromPortIndex = fromNode.outputs.indexOf(fromPort);
            const toPortIndex = toNode.inputs.indexOf(toPort);

            const x1 = fromNode.x + fromNode.width;
            const y1 = fromNode.y + 50 + fromPortIndex * 28;
            const x2 = toNode.x;
            const y2 = toNode.y + 50 + toPortIndex * 28;

            const dx = Math.abs(x2 - x1) * 0.5;
            const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

            return (
                <g key={conn.id} className="cursor-pointer group/conn" onClick={() => removeConnection(conn.id)}>
                    <path d={path} fill="none" stroke="transparent" strokeWidth="12" />
                    <path
                        d={path}
                        fill="none"
                        stroke={fromNode.color}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        className="transition-all group-hover/conn:stroke-red-500 group-hover/conn:stroke-[3.5]"
                        style={{ filter: `drop-shadow(0 0 4px ${fromNode.color}40)` }}
                    />
                    {/* Animated flow dot */}
                    <circle r="3" fill={fromNode.color} opacity="0.8">
                        <animateMotion dur="2s" repeatCount="indefinite" path={path} />
                    </circle>
                </g>
            );
        });
    };

    // ========== Render Connecting Line Preview ==========
    const renderConnectingLine = () => {
        if (!connectingFrom || !activePipeline) return null;

        const fromNode = activePipeline.nodes.find(n => n.id === connectingFrom.nodeId);
        if (!fromNode) return null;

        const isOutput = fromNode.outputs.some(p => p.id === connectingFrom.portId);
        const port = isOutput
            ? fromNode.outputs.find(p => p.id === connectingFrom.portId)
            : fromNode.inputs.find(p => p.id === connectingFrom.portId);
        if (!port) return null;

        const portIndex = isOutput
            ? fromNode.outputs.indexOf(port)
            : fromNode.inputs.indexOf(port);

        const x1 = isOutput ? fromNode.x + fromNode.width : fromNode.x;
        const y1 = fromNode.y + 50 + portIndex * 28;
        const x2 = mousePos.x;
        const y2 = mousePos.y;

        const dx = Math.abs(x2 - x1) * 0.5;
        const path = `M ${x1} ${y1} C ${x1 + (isOutput ? dx : -dx)} ${y1}, ${x2 + (isOutput ? -dx : dx)} ${y2}, ${x2} ${y2}`;

        return (
            <path
                d={path}
                fill="none"
                stroke="#60a5fa"
                strokeWidth="2"
                strokeDasharray="6 4"
                strokeLinecap="round"
                opacity="0.7"
            />
        );
    };

    // ========== Filter Templates ==========
    const filteredTemplates = NODE_TEMPLATES.filter(t =>
        t.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.type.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const groupedTemplates = Object.keys(CATEGORY_META).reduce((acc, cat) => {
        acc[cat as NodeCategory] = filteredTemplates.filter(t => t.category === cat);
        return acc;
    }, {} as Record<NodeCategory, NodeTemplate[]>);

    // ========== Create Pipeline ==========
    const handleCreatePipeline = () => {
        if (!currentUser || !newPipelineName.trim()) return;
        createPipeline(currentUser.id, null, newPipelineName.trim(), newPipelineDesc.trim());
        setShowCreatePipeline(false);
        setNewPipelineName('');
        setNewPipelineDesc('');
    };

    const selectedNode = activePipeline?.nodes.find(n => n.id === selectedNodeId);

    return (
        <div className="h-full flex flex-col -m-6 -mt-6">
            {/* Top Bar */}
            <div className="h-14 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between px-4 shrink-0 z-20">
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <button
                            id="pipeline-selector"
                            onClick={() => setShowPipelineList(!showPipelineList)}
                            className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-slate-700 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-600 transition-all border border-gray-200 dark:border-slate-600"
                        >
                            <Layers className="w-4 h-4 text-gray-400" />
                            {activePipeline ? activePipeline.name : 'Select Pipeline'}
                            <ChevronDown className="w-3 h-3 text-gray-400" />
                        </button>

                        {showPipelineList && (
                            <div className="absolute top-full left-0 mt-2 w-72 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-2xl z-50 overflow-hidden">
                                <div className="p-3 border-b border-gray-100 dark:border-slate-700">
                                    <button
                                        onClick={() => { setShowPipelineList(false); setShowCreatePipeline(true); }}
                                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 text-sm font-medium hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-all"
                                    >
                                        <Plus className="w-4 h-4" /> New Pipeline
                                    </button>
                                </div>
                                <div className="max-h-60 overflow-y-auto">
                                    {pipelines.length === 0 ? (
                                        <p className="p-4 text-center text-gray-400 text-sm">No pipelines yet</p>
                                    ) : (
                                        pipelines.map(p => (
                                            <button
                                                key={p.id}
                                                onClick={() => { setActivePipeline(p.id); setShowPipelineList(false); }}
                                                className={`w-full flex items-center justify-between px-4 py-3 text-sm hover:bg-gray-50 dark:hover:bg-slate-700 transition-all border-b border-gray-50 dark:border-slate-700/50 last:border-0 ${p.id === activePipelineId ? 'bg-blue-50 dark:bg-blue-500/10' : ''
                                                    }`}
                                            >
                                                <div className="text-left">
                                                    <p className={`font-medium ${p.id === activePipelineId ? 'text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}>{p.name}</p>
                                                    <p className="text-xs text-gray-400 mt-0.5">{p.nodes.length} nodes · {p.connections.length} connections</p>
                                                </div>
                                                <div className="flex gap-1">
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); duplicatePipeline(p.id); }}
                                                        className="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-400 transition-all"
                                                    >
                                                        <Copy className="w-3 h-3" />
                                                    </button>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); deletePipeline(p.id); }}
                                                        className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-all"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            </button>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {activePipeline && (
                        <div className="flex items-center gap-1.5">
                            <span className="text-xs text-gray-400">{activePipeline.nodes.length} nodes</span>
                            <span className="text-gray-300 dark:text-gray-600">·</span>
                            <span className="text-xs text-gray-400">{activePipeline.connections.length} connections</span>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowToolbar(!showToolbar)}
                        className={`p-2 rounded-lg transition-all ${showToolbar ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-500' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700'}`}
                        title="Toggle node palette"
                    >
                        <Layers className="w-4 h-4" />
                    </button>
                    <div className="h-6 w-px bg-gray-200 dark:bg-slate-700" />
                    <button onClick={() => setZoom(zoom - 0.1)} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-all" title="Zoom out">
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <span className="text-xs text-gray-500 font-mono min-w-[3rem] text-center">{Math.round(zoom * 100)}%</span>
                    <button onClick={() => setZoom(zoom + 0.1)} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-all" title="Zoom in">
                        <ZoomIn className="w-4 h-4" />
                    </button>
                    <button onClick={() => { setPanOffset({ x: 0, y: 0 }); setZoom(1); }} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-all" title="Reset view">
                        <RotateCcw className="w-4 h-4" />
                    </button>
                    <button onClick={() => { setPanOffset({ x: 0, y: 0 }); setZoom(1); }} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-all" title="Fit to screen">
                        <Maximize2 className="w-4 h-4" />
                    </button>
                    <div className="h-6 w-px bg-gray-200 dark:bg-slate-700" />
                    {activePipeline && (
                        <>
                            <button className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-500/20 transition-all">
                                <Play className="w-3 h-3" /> Run
                            </button>
                            <button className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 text-xs font-semibold transition-all">
                                <Square className="w-3 h-3" /> Stop
                            </button>
                        </>
                    )}
                </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
                {/* Sidebar - Node Palette */}
                {showToolbar && (
                    <div className="w-72 bg-white dark:bg-slate-800 border-r border-gray-200 dark:border-slate-700 flex flex-col shrink-0 overflow-hidden">
                        <div className="p-3">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                <input
                                    id="node-search"
                                    type="text"
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-sm text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all"
                                    placeholder="Search nodes..."
                                />
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
                            {(Object.keys(CATEGORY_META) as NodeCategory[]).map(cat => {
                                const templates = groupedTemplates[cat];
                                if (templates.length === 0) return null;
                                const meta = CATEGORY_META[cat];
                                const isExpanded = expandedCategory === cat || searchQuery.length > 0;

                                return (
                                    <div key={cat}>
                                        <button
                                            onClick={() => setExpandedCategory(isExpanded && !searchQuery ? null : cat)}
                                            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-all text-sm font-semibold"
                                            style={{ color: meta.color }}
                                        >
                                            {meta.icon}
                                            <span>{meta.label}</span>
                                            <span className="ml-auto text-xs text-gray-400 font-normal">{templates.length}</span>
                                            <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                        </button>

                                        {isExpanded && (
                                            <div className="space-y-1 mt-1 mb-2">
                                                {templates.map(template => (
                                                    <div
                                                        key={template.type}
                                                        draggable
                                                        onDragEnd={(e) => handleTemplateDrop(template, e as unknown as React.DragEvent)}
                                                        onClick={() => {
                                                            if (activePipeline) {
                                                                const x = (-panOffset.x + 400) / zoom;
                                                                const y = (-panOffset.y + 200) / zoom;
                                                                addNode(template, Math.round(x / 10) * 10, Math.round(y / 10) * 10);
                                                            }
                                                        }}
                                                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all group hover:bg-gray-50 dark:hover:bg-slate-700/50 border border-transparent hover:border-gray-200 dark:hover:border-slate-600"
                                                    >
                                                        <div
                                                            className="w-9 h-9 rounded-lg flex items-center justify-center text-base shrink-0 transition-transform group-hover:scale-110"
                                                            style={{ backgroundColor: template.color + '15', border: `1px solid ${template.color}25` }}
                                                        >
                                                            {template.icon}
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate">{template.label}</p>
                                                            <p className="text-[10px] text-gray-400 truncate">{template.description}</p>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Main Canvas */}
                <div
                    ref={canvasRef}
                    className="flex-1 overflow-hidden relative"
                    style={{ background: 'var(--app-bg)', cursor: isPanning ? 'grabbing' : connectingFrom ? 'crosshair' : 'default' }}
                    onMouseDown={handleCanvasMouseDown}
                    onMouseMove={handleCanvasMouseMove}
                    onMouseUp={handleCanvasMouseUp}
                    onMouseLeave={handleCanvasMouseUp}
                    onWheel={handleWheel}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => {
                        // Handled in the template's dragEnd for simplicity
                    }}
                >
                    {/* Grid pattern */}
                    <div
                        className="absolute inset-0 pointer-events-none opacity-30 dark:opacity-10"
                        style={{
                            backgroundImage: `
                radial-gradient(circle, #94a3b8 0.8px, transparent 0.8px)
              `,
                            backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
                            backgroundPosition: `${panOffset.x}px ${panOffset.y}px`,
                        }}
                    />

                    {!activePipeline ? (
                        // Empty state
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="text-center max-w-md">
                                <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gray-100 dark:bg-slate-800 flex items-center justify-center border border-gray-200 dark:border-slate-700">
                                    <Layers className="w-10 h-10 text-gray-400" />
                                </div>
                                <h3 className="text-xl font-bold text-gray-700 dark:text-gray-300 mb-2">Pipeline Editor</h3>
                                <p className="text-gray-500 mb-6 text-sm">
                                    Create a pipeline to start building your data flow. Drag nodes from the palette and connect them together.
                                </p>
                                <button
                                    onClick={() => setShowCreatePipeline(true)}
                                    className="inline-flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-blue-500 to-cyan-500 text-white font-semibold rounded-xl shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40 hover:-translate-y-0.5 transition-all"
                                >
                                    <Plus className="w-5 h-5" /> Create Pipeline
                                </button>
                            </div>
                        </div>
                    ) : (
                        // Canvas content
                        <div
                            style={{
                                transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                                transformOrigin: '0 0',
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '5000px',
                                height: '5000px',
                            }}
                        >
                            {/* SVG for connections */}
                            <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 1 }}>
                                <g className="pointer-events-auto">
                                    {renderConnections()}
                                    {renderConnectingLine()}
                                </g>
                            </svg>

                            {/* Nodes */}
                            {activePipeline.nodes.map(node => (
                                <div
                                    key={node.id}
                                    className={`pipeline-node absolute select-none transition-shadow duration-200 ${selectedNodeId === node.id ? 'z-20' : 'z-10'
                                        }`}
                                    style={{
                                        left: node.x,
                                        top: node.y,
                                        width: node.width,
                                    }}
                                    onMouseDown={(e) => handleNodeMouseDown(node.id, e)}
                                >
                                    <div
                                        className={`rounded-2xl border-2 overflow-hidden backdrop-blur-sm transition-all duration-200 ${selectedNodeId === node.id
                                            ? 'shadow-xl scale-[1.02]'
                                            : 'shadow-md hover:shadow-lg'
                                            }`}
                                        style={{
                                            borderColor: selectedNodeId === node.id ? node.color : node.color + '40',
                                            background: `linear-gradient(135deg, ${'rgba(255,255,255,0.95)'}, ${'rgba(255,255,255,0.85)'})`,
                                        }}
                                    >
                                        {/* Node header */}
                                        <div
                                            className="px-4 py-2.5 flex items-center gap-2 cursor-grab active:cursor-grabbing"
                                            style={{ background: node.color + '12' }}
                                        >
                                            <span className="text-lg">{node.icon}</span>
                                            <span className="text-xs font-bold truncate" style={{ color: node.color }}>{node.label}</span>
                                            <div className="ml-auto flex gap-1">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setShowNodeConfig(true); selectNode(node.id); }}
                                                    className="p-1 rounded-lg hover:bg-white/50 transition-all"
                                                    title="Configure"
                                                >
                                                    <Edit3 className="w-3 h-3" style={{ color: node.color + '80' }} />
                                                </button>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); removeNode(node.id); }}
                                                    className="p-1 rounded-lg hover:bg-red-100 transition-all"
                                                    title="Delete node"
                                                >
                                                    <X className="w-3 h-3 text-gray-400 hover:text-red-500" />
                                                </button>
                                            </div>
                                        </div>

                                        {/* Ports */}
                                        <div className="px-2 py-2 space-y-1">
                                            {node.inputs.map((port) => (
                                                <div key={port.id} className="flex items-center gap-2 relative" style={{ minHeight: '22px' }}>
                                                    <div
                                                        className="absolute -left-[13px] w-[10px] h-[10px] rounded-full border-2 cursor-pointer transition-all hover:scale-150 z-30"
                                                        style={{
                                                            borderColor: node.color,
                                                            backgroundColor: connectingFrom ? node.color : 'white',
                                                            top: '50%',
                                                            transform: 'translateY(-50%)',
                                                        }}
                                                        onClick={(e) => handlePortClick(node.id, port.id, e)}
                                                    />
                                                    <span className="text-[10px] text-gray-500 pl-1">{port.label}</span>
                                                    <span className="text-[8px] text-gray-300 ml-auto px-1.5 py-0.5 rounded-full bg-gray-100">{port.dataType}</span>
                                                </div>
                                            ))}
                                            {node.outputs.map((port) => (
                                                <div key={port.id} className="flex items-center gap-2 relative justify-end" style={{ minHeight: '22px' }}>
                                                    <span className="text-[8px] text-gray-300 px-1.5 py-0.5 rounded-full bg-gray-100">{port.dataType}</span>
                                                    <span className="text-[10px] text-gray-500 pr-1">{port.label}</span>
                                                    <div
                                                        className="absolute -right-[13px] w-[10px] h-[10px] rounded-full border-2 cursor-pointer transition-all hover:scale-150 z-30"
                                                        style={{
                                                            borderColor: node.color,
                                                            backgroundColor: connectingFrom ? node.color : 'white',
                                                            top: '50%',
                                                            transform: 'translateY(-50%)',
                                                        }}
                                                        onClick={(e) => handlePortClick(node.id, port.id, e)}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Mini-map indicator */}
                    {activePipeline && activePipeline.nodes.length > 0 && (
                        <div className="absolute bottom-4 right-4 w-36 h-24 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden shadow-lg z-20">
                            <svg className="w-full h-full">
                                {activePipeline.nodes.map(node => {
                                    const scale = 0.03;
                                    return (
                                        <rect
                                            key={node.id}
                                            x={node.x * scale + 68}
                                            y={node.y * scale + 12}
                                            width={node.width * scale}
                                            height={(node.height || 80) * scale}
                                            rx="1"
                                            fill={node.color + '60'}
                                            stroke={node.color}
                                            strokeWidth="0.5"
                                        />
                                    );
                                })}
                            </svg>
                        </div>
                    )}
                </div>

                {/* Node Config Panel */}
                {showNodeConfig && selectedNode && (
                    <div className="w-80 bg-white dark:bg-slate-800 border-l border-gray-200 dark:border-slate-700 flex flex-col shrink-0 overflow-hidden">
                        <div className="p-4 border-b border-gray-100 dark:border-slate-700 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-lg">{selectedNode.icon}</span>
                                <h3 className="text-sm font-bold" style={{ color: selectedNode.color }}>{selectedNode.label}</h3>
                            </div>
                            <button onClick={() => setShowNodeConfig(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 transition-all">
                                <X className="w-4 h-4 text-gray-400" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            <div>
                                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Node ID</label>
                                <p className="text-xs text-gray-400 font-mono break-all">{selectedNode.id}</p>
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Category</label>
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold"
                                    style={{ backgroundColor: selectedNode.color + '15', color: selectedNode.color }}>
                                    {CATEGORY_META[selectedNode.category]?.icon}
                                    {CATEGORY_META[selectedNode.category]?.label}
                                </span>
                            </div>
                            <div className="border-t border-gray-100 dark:border-slate-700 pt-4">
                                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">Configuration</label>
                                {Object.entries(selectedNode.config).map(([key, value]) => (
                                    <div key={key} className="mb-3">
                                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1 capitalize">{key.replace(/_/g, ' ')}</label>
                                        {typeof value === 'boolean' ? (
                                            <button
                                                onClick={() => {
                                                    const newConfig = { ...selectedNode.config, [key]: !value };
                                                    store.updateNode(selectedNode.id, { config: newConfig });
                                                }}
                                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${value ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400' : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-gray-400'}`}
                                            >
                                                {value ? 'Enabled' : 'Disabled'}
                                            </button>
                                        ) : Array.isArray(value) ? (
                                            <input
                                                type="text"
                                                value={JSON.stringify(value)}
                                                onChange={e => {
                                                    try {
                                                        const parsed = JSON.parse(e.target.value);
                                                        store.updateNode(selectedNode.id, { config: { ...selectedNode.config, [key]: parsed } });
                                                    } catch { /* ignore parse errors while typing */ }
                                                }}
                                                className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-lg text-xs text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                                            />
                                        ) : typeof value === 'number' ? (
                                            <input
                                                type="number"
                                                value={value}
                                                onChange={e => {
                                                    store.updateNode(selectedNode.id, { config: { ...selectedNode.config, [key]: parseFloat(e.target.value) || 0 } });
                                                }}
                                                className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-lg text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                                            />
                                        ) : String(value).includes('\n') ? (
                                            <textarea
                                                value={String(value)}
                                                onChange={e => {
                                                    store.updateNode(selectedNode.id, { config: { ...selectedNode.config, [key]: e.target.value } });
                                                }}
                                                rows={4}
                                                className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-lg text-xs text-gray-700 dark:text-gray-300 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30 resize-none"
                                            />
                                        ) : (
                                            <input
                                                type="text"
                                                value={String(value)}
                                                onChange={e => {
                                                    store.updateNode(selectedNode.id, { config: { ...selectedNode.config, [key]: e.target.value } });
                                                }}
                                                className="w-full px-3 py-2 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-lg text-xs text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                                            />
                                        )}
                                    </div>
                                ))}
                            </div>
                            <div className="border-t border-gray-100 dark:border-slate-700 pt-4">
                                <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Ports</label>
                                {selectedNode.inputs.length > 0 && (
                                    <div className="mb-2">
                                        <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Inputs</p>
                                        {selectedNode.inputs.map(p => (
                                            <div key={p.id} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 py-1">
                                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedNode.color }} />
                                                {p.label} <span className="text-gray-300 text-[10px]">({p.dataType})</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {selectedNode.outputs.length > 0 && (
                                    <div>
                                        <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Outputs</p>
                                        {selectedNode.outputs.map(p => (
                                            <div key={p.id} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 py-1">
                                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedNode.color }} />
                                                {p.label} <span className="text-gray-300 text-[10px]">({p.dataType})</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Create Pipeline Modal */}
            {showCreatePipeline && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 p-8 max-w-lg w-full shadow-2xl">
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6">Create New Pipeline</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Pipeline Name</label>
                                <input
                                    id="pipeline-name-input"
                                    type="text"
                                    value={newPipelineName}
                                    onChange={e => setNewPipelineName(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all text-sm"
                                    placeholder="e.g. Telemetry Processing, CV Pipeline..."
                                    autoFocus
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Description</label>
                                <textarea
                                    value={newPipelineDesc}
                                    onChange={e => setNewPipelineDesc(e.target.value)}
                                    rows={3}
                                    className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all text-sm resize-none"
                                    placeholder="What does this pipeline do?"
                                />
                            </div>
                        </div>
                        <div className="flex gap-3 mt-6">
                            <button
                                onClick={() => { setShowCreatePipeline(false); setNewPipelineName(''); setNewPipelineDesc(''); }}
                                className="flex-1 py-3 rounded-xl bg-gray-100 hover:bg-gray-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 font-medium transition-all text-sm"
                            >
                                Cancel
                            </button>
                            <button
                                id="create-pipeline-submit"
                                onClick={handleCreatePipeline}
                                disabled={!newPipelineName.trim()}
                                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-400 hover:to-cyan-400 text-white font-semibold transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                            >
                                Create Pipeline
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

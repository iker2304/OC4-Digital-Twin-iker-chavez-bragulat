import { useCallback, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  Panel,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { 
  Plus, Play, RotateCcw, Trash2, Download, 
  ChevronDown, Layers, Copy, ExternalLink, Clock, ArrowLeft 
} from 'lucide-react';
import { useNodeEditorStore, NODE_TEMPLATES, type NodeTemplate, type Flow } from '../../store/nodeEditorStore';
import { useProfileStore } from '../../store/profileStore';
import CustomNode from './nodes/CustomNode';
import TerminalNode from './nodes/TerminalNode';
import NodePalette from './NodePalette';
import NodeConfigPanel from './NodeConfigPanel';

const nodeTypes = { custom: CustomNode, terminal: TerminalNode };

interface NodeEditorProps {
  userId: string;
  profileId: string;
}

export default function NodeEditor({ userId, profileId }: NodeEditorProps) {
  const {
    flows, activeFlowId,
    nodes, edges,
    onNodesChange, onEdgesChange, onConnect,
    selectedNodeId, selectNode,
    createFlow, deleteFlow, duplicateFlow, setActiveFlow, deployFlow,
    addNodeFromTemplate,
    saveCurrentFlow,
  } = useNodeEditorStore();

  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const [showFlowList, setShowFlowList] = useState(false);
  const [showCreateFlow, setShowCreateFlow] = useState(false);
  const [newFlowName, setNewFlowName] = useState('');
  const [newFlowDesc, setNewFlowDesc] = useState('');
  const [isDeployed, setIsDeployed] = useState(false);

  const activeFlow = flows.find(f => f.id === activeFlowId);
  const selectedNode = nodes.find(n => n.id === selectedNodeId);

  // ── Drop handler (drag from palette) ──
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const nodeType = e.dataTransfer.getData('application/nodetemplate');
    if (!nodeType || !activeFlowId) return;

    const template = NODE_TEMPLATES.find(t => t.type === nodeType);
    if (!template) return;

    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNodeFromTemplate(template, position);
  }, [activeFlowId, screenToFlowPosition, addNodeFromTemplate]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // ── Add from palette click ──
  const handleAddNode = useCallback((template: NodeTemplate) => {
    if (!activeFlowId) return;
    addNodeFromTemplate(template, {
      x: 200 + Math.random() * 300,
      y: 150 + Math.random() * 200,
    });
  }, [activeFlowId, addNodeFromTemplate]);

  // ── Create flow ──
  const handleCreateFlow = () => {
    if (!newFlowName.trim()) return;
    createFlow(userId, profileId, newFlowName.trim(), newFlowDesc.trim());
    setShowCreateFlow(false);
    setNewFlowName('');
    setNewFlowDesc('');
  };

  // ── Deploy ──
  const handleDeploy = () => {
    if (!activeFlowId) return;
    deployFlow(activeFlowId);
    setIsDeployed(true);
    setTimeout(() => setIsDeployed(false), 3000);
  };

  // ── Export / Import ──
  const handleExport = () => {
    if (!activeFlow) return;
    const json = JSON.stringify({ nodes, edges, meta: { name: activeFlow.name } }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${activeFlow.name.replace(/\s+/g, '_')}_flow.json`;
    a.click();
  };

  return (
    <div className="flex h-full overflow-hidden" style={{ background: 'var(--app-bg)' }}>
      {/* ── Palette ── */}
      <NodePalette onAddNode={handleAddNode} />

      {/* ── Main canvas area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top toolbar */}
        <div className="h-12 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between px-3 shrink-0 z-20">
          <div className="flex items-center gap-1">
            {activeFlow && (
              <button
                onClick={() => setActiveFlow(null)}
                className="flex items-center justify-center p-1.5 rounded-xl text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-slate-700 transition-all mr-1"
                title="Back to Pipeline Manager"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}

            {/* Flow selector */}
            <div className="relative">
              <button
                onClick={() => setShowFlowList(!showFlowList)}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-slate-700 rounded-xl text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-600 border border-gray-200 dark:border-slate-600 transition-all max-w-[200px]"
              >
                <Layers className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <span className="truncate">{activeFlow ? activeFlow.name : 'Select Flow'}</span>
                <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />
              </button>

              {showFlowList && (
                <div className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-2xl z-50 overflow-hidden">
                  <div className="p-2 border-b border-gray-100 dark:border-slate-700">
                    <button
                      onClick={() => { setShowFlowList(false); setShowCreateFlow(true); }}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-semibold hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-all"
                    >
                      <Plus className="w-3.5 h-3.5" /> New Flow
                    </button>
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {flows.length === 0 ? (
                      <p className="p-4 text-center text-xs text-gray-400">No flows yet</p>
                    ) : flows.map(f => (
                      <div
                        key={f.id}
                        className={`flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-700 border-b border-gray-50 dark:border-slate-700/50 last:border-0 cursor-pointer ${f.id === activeFlowId ? 'bg-blue-50 dark:bg-blue-500/10' : ''}`}
                        onClick={() => { setActiveFlow(f.id); setShowFlowList(false); }}
                      >
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-semibold truncate ${f.id === activeFlowId ? 'text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}>{f.name}</p>
                          <p className="text-[10px] text-gray-400">{f.nodes.length} nodes · {f.deployed ? '🟢 Deployed' : '⚪ Draft'}</p>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={e => { e.stopPropagation(); duplicateFlow(f.id); }}
                            className="p-1 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-400 transition-all"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); deleteFlow(f.id); }}
                            className="p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-all"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {activeFlow && (
              <div className="flex items-center gap-1 text-[10px] text-gray-400">
                <span>{nodes.length} nodes</span>
                <span className="text-gray-300">·</span>
                <span>{edges.length} edges</span>
                {activeFlow.deployed && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="text-emerald-500 font-semibold">● Deployed</span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5">
            {activeFlow && (
              <>
                <button
                  onClick={handleExport}
                  className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-all"
                  title="Export flow"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button
                  onClick={saveCurrentFlow}
                  className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-all"
                  title="Reset view"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <div className="w-px h-5 bg-gray-200 dark:bg-slate-700" />
                <button
                  onClick={handleDeploy}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-sm ${
                    isDeployed
                      ? 'bg-emerald-500 text-white shadow-emerald-500/30'
                      : 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-400 hover:to-teal-400 shadow-emerald-500/20 hover:shadow-emerald-500/40'
                  }`}
                >
                  <Play className="w-3 h-3" />
                  {isDeployed ? 'Deployed!' : 'Deploy Flow'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Canvas */}
        <div
          ref={reactFlowWrapper}
          className="flex-1 overflow-hidden"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          {!activeFlow ? (
            // ── Pipeline Manager Dashboard (General Interface) ──
            <div className="h-full flex flex-col bg-gray-50 dark:bg-slate-900 overflow-y-auto custom-scrollbar p-8">
              <div className="max-w-6xl mx-auto w-full">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h2 className="text-2xl font-black text-gray-900 dark:text-white">Pipeline Manager</h2>
                    <p className="text-sm text-gray-500 mt-1">Manage and monitor all data processing flows for this profile.</p>
                  </div>
                  <button
                    onClick={() => setShowCreateFlow(true)}
                    className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-bold rounded-xl shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40 hover:-translate-y-0.5 transition-all"
                  >
                    <Plus className="w-4 h-4" /> Create New Pipeline
                  </button>
                </div>

                {flows.length === 0 ? (
                  <div className="bg-white dark:bg-slate-800 rounded-3xl border-2 border-dashed border-gray-200 dark:border-slate-700 p-12 text-center">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center">
                      <Layers className="w-8 h-8 text-blue-500" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-700 dark:text-gray-300">No pipelines yet</h3>
                    <p className="text-sm text-gray-400 mt-2 mb-6">Start by creating your first data processing pipeline to connect sensors to dashboards.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {flows.map(flow => (
                      <PipelineCard 
                        key={flow.id} 
                        flow={flow} 
                        onOpen={() => setActiveFlow(flow.id)}
                        onDelete={() => deleteFlow(flow.id)}
                        onDuplicate={() => duplicateFlow(flow.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => selectNode(node.id)}
              onPaneClick={() => selectNode(null)}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              defaultEdgeOptions={{
                type: 'smoothstep',
                animated: true,
                style: { strokeWidth: 2, stroke: '#6366f1' },
              }}
              proOptions={{ hideAttribution: true }}
              className="bg-gray-50 dark:bg-slate-900"
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--chart-grid)"
              />
              <Controls
                className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-sm overflow-hidden"
              />
              <MiniMap
                className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-sm overflow-hidden"
                nodeColor={(node) => {
                  const d = node.data as { color?: string };
                  return d.color ? `${d.color}80` : '#6366f180';
                }}
                maskColor="rgba(0,0,0,0.05)"
              />
              <Panel position="top-right">
                <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm rounded-xl border border-gray-200 dark:border-slate-700 px-3 py-1.5 text-[10px] text-gray-400">
                  Scroll to zoom · Alt+drag to pan · Click port to connect
                </div>
              </Panel>
            </ReactFlow>
          )}
        </div>
      </div>

      {/* ── Config panel ── */}
      {selectedNode && (
        <NodeConfigPanel
          node={selectedNode}
          onClose={() => selectNode(null)}
        />
      )}

      {/* ── Create Flow Modal ── */}
      {showCreateFlow && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 p-8 max-w-md w-full shadow-2xl">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6">Create New Flow</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Flow Name</label>
                <input
                  autoFocus
                  type="text"
                  value={newFlowName}
                  onChange={e => setNewFlowName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateFlow()}
                  className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                  placeholder="e.g. Telemetry Processing, Anomaly Detection..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Description</label>
                <textarea
                  value={newFlowDesc}
                  onChange={e => setNewFlowDesc(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all resize-none"
                  placeholder="What does this flow do?"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { setShowCreateFlow(false); setNewFlowName(''); setNewFlowDesc(''); }}
                className="flex-1 py-3 rounded-xl bg-gray-100 hover:bg-gray-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 font-medium text-sm transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateFlow}
                disabled={!newFlowName.trim()}
                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-400 hover:to-cyan-400 text-white font-semibold text-sm transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Flow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pipeline Card component ──
function PipelineCard({ 
  flow, onOpen, onDelete, onDuplicate 
}: { 
  flow: Flow; onOpen: () => void; onDelete: () => void; onDuplicate: () => void; 
}) {
  const { profiles } = useProfileStore();
  const profile = profiles.find(p => p.id === flow.profileId);

  return (
    <div className="group bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 p-5 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col h-full">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div 
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
            style={{ background: `${profile?.color || '#3b82f6'}15`, border: `1px solid ${profile?.color || '#3b82f6'}30` }}
          >
            {profile?.icon || '📦'}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-gray-900 dark:text-white truncate group-hover:text-blue-500 transition-colors">
              {flow.name}
            </h3>
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">
              {profile?.name || 'Unknown Profile'}
            </p>
          </div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold shrink-0 ${flow.deployed ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400' : 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-gray-400'}`}>
          {flow.deployed ? 'DEPLOYED' : 'DRAFT'}
        </span>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mb-6 flex-1">
        {flow.description || 'No description provided for this data flow.'}
      </p>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-gray-50 dark:bg-slate-900/50 rounded-2xl p-3 border border-gray-100 dark:border-slate-700/50">
          <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Nodes</p>
          <div className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-blue-500" />
            <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{flow.nodes.length}</span>
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-slate-900/50 rounded-2xl p-3 border border-gray-100 dark:border-slate-700/50">
          <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Updated</p>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-orange-500" />
            <span className="text-xs font-bold text-gray-700 dark:text-gray-200">
              {new Date(flow.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-4 border-t border-gray-50 dark:border-slate-700/50 mt-auto">
        <button
          onClick={onOpen}
          className="flex-1 flex items-center justify-center gap-2 py-2 px-3 bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-bold rounded-xl hover:bg-blue-600 hover:text-white dark:hover:bg-blue-500 transition-all shadow-sm"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Open Editor
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

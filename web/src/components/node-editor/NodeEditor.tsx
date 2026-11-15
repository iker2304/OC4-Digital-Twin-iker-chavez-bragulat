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
  ChevronDown, Layers, Copy, ExternalLink, Clock, ArrowLeft, X,
} from 'lucide-react';
import { useNodeEditorStore, NODE_TEMPLATES, type NodeTemplate, type Flow } from '../../store/nodeEditorStore';
import { useProfileStore } from '../../store/profileStore';
import CustomNode from './nodes/CustomNode';
import TerminalNode from './nodes/TerminalNode';
import NodePalette from './NodePalette';
import NodeConfigPanel from './NodeConfigPanel';
import { Glyph } from '../ui/Glyph';
import { Badge, Button, Card, EmptyState, StatusDot } from '../ui';

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

  const handleAddNode = useCallback((template: NodeTemplate) => {
    if (!activeFlowId) return;
    addNodeFromTemplate(template, {
      x: 200 + Math.random() * 300,
      y: 150 + Math.random() * 200,
    });
  }, [activeFlowId, addNodeFromTemplate]);

  const handleCreateFlow = () => {
    if (!newFlowName.trim()) return;
    createFlow(userId, profileId, newFlowName.trim(), newFlowDesc.trim());
    setShowCreateFlow(false);
    setNewFlowName('');
    setNewFlowDesc('');
  };

  const handleDeploy = () => {
    if (!activeFlowId) return;
    deployFlow(activeFlowId);
    setIsDeployed(true);
    setTimeout(() => setIsDeployed(false), 3000);
  };

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
    <div className="flex h-full overflow-hidden bg-gray-50 dark:bg-slate-950">
      {/* Palette */}
      <NodePalette onAddNode={handleAddNode} />

      {/* Main canvas area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top toolbar */}
        <div className="h-11 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between px-3 shrink-0 z-20">
          <div className="flex items-center gap-2">
            {activeFlow && (
              <button
                onClick={() => setActiveFlow(null)}
                className="flex items-center justify-center p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:text-gray-100 dark:hover:bg-slate-800 transition-colors"
                title="Volver al gestor de flujos"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Flow selector */}
            <div className="relative">
              <button
                onClick={() => setShowFlowList(!showFlowList)}
                className="flex items-center gap-2 px-2.5 py-1.5 bg-white dark:bg-slate-900 rounded-md text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-800 border border-gray-200 dark:border-slate-800 transition-colors max-w-[220px]"
              >
                <Layers className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <span className="truncate">{activeFlow ? activeFlow.name : 'Seleccionar flujo'}</span>
                <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />
              </button>

              {showFlowList && (
                <div className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 shadow-lg z-50 overflow-hidden">
                  <div className="p-2 border-b border-gray-100 dark:border-slate-800">
                    <button
                      onClick={() => { setShowFlowList(false); setShowCreateFlow(true); }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-xs font-medium hover:bg-gray-800 dark:hover:bg-white transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> Nuevo flujo
                    </button>
                  </div>
                  <div className="max-h-56 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-800">
                    {flows.length === 0 ? (
                      <p className="p-4 text-center text-xs text-gray-500">Sin flujos creados</p>
                    ) : flows.map(f => (
                      <div
                        key={f.id}
                        className={`flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/70 cursor-pointer ${f.id === activeFlowId ? 'bg-gray-50 dark:bg-slate-800/50' : ''}`}
                        onClick={() => { setActiveFlow(f.id); setShowFlowList(false); }}
                      >
                        <StatusDot status={f.deployed ? 'online' : 'offline'} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-medium truncate ${f.id === activeFlowId ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}`}>{f.name}</p>
                          <p className="text-[11px] text-gray-500">{f.nodes.length} nodos · {f.deployed ? 'Desplegado' : 'Borrador'}</p>
                        </div>
                        <div className="flex gap-0.5">
                          <button
                            onClick={e => { e.stopPropagation(); duplicateFlow(f.id); }}
                            className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                            title="Duplicar"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); deleteFlow(f.id); }}
                            className="p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-600 transition-colors"
                            title="Eliminar"
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
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="font-mono">{nodes.length} nodos</span>
                <span className="text-gray-300 dark:text-slate-700">·</span>
                <span className="font-mono">{edges.length} conexiones</span>
                {activeFlow.deployed && (
                  <Badge variant="success">
                    <StatusDot status="online" /> Desplegado
                  </Badge>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5">
            {activeFlow && (
              <>
                <Button variant="ghost" size="sm" onClick={handleExport} title="Exportar flujo JSON">
                  <Download className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={saveCurrentFlow} title="Guardar cambios">
                  <RotateCcw className="w-3.5 h-3.5" />
                </Button>
                <div className="w-px h-4 bg-gray-200 dark:bg-slate-800 mx-0.5" />
                <Button
                  variant={isDeployed ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={handleDeploy}
                >
                  <Play className="w-3 h-3" />
                  {isDeployed ? 'Desplegado' : 'Desplegar flujo'}
                </Button>
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
            <div className="h-full flex flex-col bg-gray-50 dark:bg-slate-950 overflow-y-auto p-6">
              <div className="max-w-5xl mx-auto w-full space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-gray-900 dark:text-white">Gestor de pipelines</h2>
                    <p className="text-xs text-gray-500 mt-0.5">Gestiona y supervisa los flujos de procesamiento de datos de este perfil.</p>
                  </div>
                  <Button variant="primary" size="md" onClick={() => setShowCreateFlow(true)}>
                    <Plus className="w-3.5 h-3.5" /> Nuevo pipeline
                  </Button>
                </div>

                {flows.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon={<Layers className="w-5 h-5" />}
                      title="Sin pipelines configurados"
                      description="Crea tu primer pipeline de datos para conectar sensores, modelos de IA y paneles en tiempo real."
                      action={
                        <Button variant="primary" size="sm" onClick={() => setShowCreateFlow(true)}>
                          <Plus className="w-3.5 h-3.5" /> Crear pipeline
                        </Button>
                      }
                    />
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                style: { strokeWidth: 1.5, stroke: '#3b82f6' },
              }}
              proOptions={{ hideAttribution: true }}
              className="bg-gray-50 dark:bg-slate-950"
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--chart-grid)"
              />
              <Controls className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-md shadow-xs overflow-hidden" />
              <MiniMap
                className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-md shadow-xs overflow-hidden"
                nodeColor={(node) => {
                  const d = node.data as { color?: string };
                  return d.color ? `${d.color}80` : '#3b82f680';
                }}
                maskColor="rgba(0,0,0,0.05)"
              />
              <Panel position="top-right">
                <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xs rounded-md border border-gray-200 dark:border-slate-800 px-2.5 py-1 text-[11px] text-gray-500">
                  Scroll para zoom · Alt+arrastrar para mover · Clic en puerto para conectar
                </div>
              </Panel>
            </ReactFlow>
          )}
        </div>
      </div>

      {/* Config panel */}
      {selectedNode && (
        <NodeConfigPanel
          node={selectedNode}
          onClose={() => selectNode(null)}
        />
      )}

      {/* Create Flow Modal */}
      {showCreateFlow && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 p-6 max-w-md w-full shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">Nuevo flujo de datos</h3>
              <button
                onClick={() => { setShowCreateFlow(false); setNewFlowName(''); setNewFlowDesc(''); }}
                className="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="ui-label">Nombre del flujo</label>
                <input
                  autoFocus
                  type="text"
                  value={newFlowName}
                  onChange={e => setNewFlowName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateFlow()}
                  className="ui-input"
                  placeholder="Ej. Telemetría principal, Detección de anomalías..."
                />
              </div>
              <div>
                <label className="ui-label">Descripción</label>
                <textarea
                  value={newFlowDesc}
                  onChange={e => setNewFlowDesc(e.target.value)}
                  rows={3}
                  className="ui-input resize-none"
                  placeholder="¿Qué procesa este flujo?"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="secondary"
                onClick={() => { setShowCreateFlow(false); setNewFlowName(''); setNewFlowDesc(''); }}
              >
                Cancelar
              </Button>
              <Button
                variant="primary"
                onClick={handleCreateFlow}
                disabled={!newFlowName.trim()}
              >
                Crear flujo
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineCard({
  flow, onOpen, onDelete, onDuplicate,
}: {
  flow: Flow; onOpen: () => void; onDelete: () => void; onDuplicate: () => void;
}) {
  const { profiles } = useProfileStore();
  const profile = profiles.find(p => p.id === flow.profileId);

  return (
    <Card className="p-4 flex flex-col h-full hover:border-gray-300 dark:hover:border-slate-700 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-md bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 flex items-center justify-center text-gray-700 dark:text-gray-200 shrink-0">
            <Glyph name={profile?.icon || 'box'} className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
              {flow.name}
            </h3>
            <p className="text-[11px] text-gray-500 truncate">
              {profile?.name || 'Perfil general'}
            </p>
          </div>
        </div>
        <Badge variant={flow.deployed ? 'success' : 'neutral'}>
          {flow.deployed ? 'Desplegado' : 'Borrador'}
        </Badge>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mb-4 flex-1">
        {flow.description || 'Sin descripción definida para este flujo de datos.'}
      </p>

      <div className="grid grid-cols-2 gap-2 mb-4 pt-3 border-t border-gray-100 dark:border-slate-800/80 text-xs">
        <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
          <Layers className="w-3.5 h-3.5 text-gray-400" />
          <span className="font-mono font-medium">{flow.nodes.length}</span>
          <span className="text-gray-400">nodos</span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300 justify-end">
          <Clock className="w-3.5 h-3.5 text-gray-400" />
          <span className="font-mono text-[11px]">
            {new Date(flow.updatedAt).toLocaleDateString('es-ES', { month: 'short', day: 'numeric' })}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mt-auto">
        <Button variant="secondary" size="sm" onClick={onOpen} className="flex-1">
          <ExternalLink className="w-3.5 h-3.5" /> Abrir editor
        </Button>
        <Button variant="ghost" size="sm" onClick={onDuplicate} title="Duplicar">
          <Copy className="w-3.5 h-3.5" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} title="Eliminar" className="hover:text-red-600">
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </Card>
  );
}

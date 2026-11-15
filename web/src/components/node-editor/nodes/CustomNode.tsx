import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { X, Settings2 } from 'lucide-react';
import { useNodeEditorStore } from '../../../store/nodeEditorStore';
import { Glyph } from '../../ui/Glyph';

interface CustomNodeData {
  type: string;
  category: string;
  label: string;
  icon: string;
  color: string;
  inputs?: { id: string; label: string; dataType: string }[];
  outputs?: { id: string; label: string; dataType: string }[];
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

const DATA_TYPE_COLORS: Record<string, string> = {
  json: '#6366f1',
  number: '#10b981',
  string: '#f59e0b',
  any: '#94a3b8',
  signal: '#8b5cf6',
  image: '#ec4899',
  mesh: '#f97316',
};

const CustomNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData = data as CustomNodeData;
  const { removeSelectedNode, selectNode } = useNodeEditorStore();

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    selectNode(id);
    removeSelectedNode();
  }, [id, removeSelectedNode, selectNode]);

  const handleConfig = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    selectNode(id);
  }, [id, selectNode]);

  const color = nodeData.color || '#3b82f6';
  const inputs = nodeData.inputs ?? [];
  const outputs = nodeData.outputs ?? [];
  const config = nodeData.config ?? {};

  return (
    <div className="pipeline-node min-w-[200px] rounded-lg overflow-visible">
      <div
        className={`rounded-lg border bg-white dark:bg-slate-900 overflow-hidden transition-shadow ${
          selected
            ? 'border-blue-500 ring-2 ring-blue-500/20 shadow-md'
            : 'border-gray-200 dark:border-slate-800 shadow-xs'
        }`}
        style={{ borderLeftWidth: 3, borderLeftColor: color }}
      >
        {/* Header */}
        <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-100 dark:border-slate-800 cursor-grab active:cursor-grabbing bg-gray-50/70 dark:bg-slate-800/50">
          <Glyph name={nodeData.icon} className="w-3.5 h-3.5 text-gray-700 dark:text-gray-200 shrink-0" />
          <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate flex-1">
            {nodeData.label}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleConfig}
              className="p-1 rounded hover:bg-gray-200/70 dark:hover:bg-slate-700 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              title="Configurar nodo"
            >
              <Settings2 className="w-3 h-3" />
            </button>
            <button
              onClick={handleDelete}
              className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-gray-400 hover:text-red-600 transition-colors"
              title="Eliminar nodo"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Ports */}
        <div className="px-3 py-2 space-y-1 relative">
          {inputs.map((port) => (
            <div
              key={port.id}
              className="flex items-center gap-2 relative"
              style={{ minHeight: '20px' }}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={port.id}
                style={{
                  left: -17,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 9,
                  height: 9,
                  background: DATA_TYPE_COLORS[port.dataType] || '#94a3b8',
                  border: '2px solid white',
                  borderRadius: '50%',
                }}
              />
              <span className="text-[11px] text-gray-600 dark:text-gray-300 truncate">{port.label}</span>
              <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-gray-400 font-mono">
                {port.dataType}
              </span>
            </div>
          ))}

          {inputs.length > 0 && outputs.length > 0 && (
            <div className="border-t border-gray-100 dark:border-slate-800 my-1" />
          )}

          {outputs.map((port) => (
            <div
              key={port.id}
              className="flex items-center gap-2 relative justify-end"
              style={{ minHeight: '20px' }}
            >
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-gray-400 font-mono">
                {port.dataType}
              </span>
              <span className="text-[11px] text-gray-600 dark:text-gray-300 truncate">{port.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                style={{
                  right: -17,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 9,
                  height: 9,
                  background: DATA_TYPE_COLORS[port.dataType] || '#94a3b8',
                  border: '2px solid white',
                  borderRadius: '50%',
                }}
              />
            </div>
          ))}

          {Object.keys(config).slice(0, 2).map(key => {
            const val = config[key];
            if (typeof val === 'object') return null;
            return (
              <div
                key={key}
                className="flex items-center gap-1 mt-1 px-2 py-0.5 rounded bg-gray-50 dark:bg-slate-800/60"
              >
                <span className="text-[10px] text-gray-400 capitalize">{key}:</span>
                <span className="text-[10px] font-mono text-gray-600 dark:text-gray-300 truncate">{String(val)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

CustomNode.displayName = 'CustomNode';

export default CustomNode;

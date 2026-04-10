import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { X, Settings2 } from 'lucide-react';
import { useNodeEditorStore } from '../../../store/nodeEditorStore';

interface CustomNodeData {
  type: string;
  category: string;
  label: string;
  icon: string;
  color: string;
  inputs: { id: string; label: string; dataType: string }[];
  outputs: { id: string; label: string; dataType: string }[];
  config: Record<string, unknown>;
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

  const color = nodeData.color || '#6366f1';

  return (
    <div
      className={`pipeline-node min-w-[200px] rounded-2xl overflow-visible transition-all duration-200 ${
        selected ? 'scale-[1.02]' : ''
      }`}
      style={{
        filter: selected
          ? `drop-shadow(0 0 12px ${color}50)`
          : `drop-shadow(0 4px 8px rgba(0,0,0,0.15))`,
      }}
    >
      {/* Main card */}
      <div
        className={`rounded-2xl border-2 overflow-hidden backdrop-blur-sm`}
        style={{
          borderColor: selected ? color : `${color}50`,
          background: 'rgba(255,255,255,0.97)',
        }}
      >
        {/* Colored accent bar */}
        <div className="h-1" style={{ background: color }} />

        {/* Header */}
        <div
          className="px-3 py-2.5 flex items-center gap-2 cursor-grab active:cursor-grabbing"
          style={{ background: `${color}10` }}
        >
          <span className="text-base leading-none">{nodeData.icon}</span>
          <span
            className="text-[11px] font-bold truncate flex-1"
            style={{ color }}
          >
            {nodeData.label}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleConfig}
              className="p-1 rounded-lg hover:bg-white/60 transition-all"
              title="Configure node"
            >
              <Settings2 className="w-3 h-3" style={{ color: `${color}90` }} />
            </button>
            <button
              onClick={handleDelete}
              className="p-1 rounded-lg hover:bg-red-100 transition-all group"
              title="Delete node"
            >
              <X className="w-3 h-3 text-gray-300 group-hover:text-red-500 transition-colors" />
            </button>
          </div>
        </div>

        {/* Ports */}
        <div className="px-3 py-2 space-y-0.5 relative">
          {/* Input ports */}
          {nodeData.inputs.map((port) => (
            <div
              key={port.id}
              className="flex items-center gap-2 relative"
              style={{ minHeight: '22px' }}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={port.id}
                style={{
                  left: -17,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 10,
                  height: 10,
                  background: DATA_TYPE_COLORS[port.dataType] || '#94a3b8',
                  border: '2px solid white',
                  borderRadius: '50%',
                  boxShadow: `0 0 0 2px ${DATA_TYPE_COLORS[port.dataType] || '#94a3b8'}40`,
                }}
              />
              <span className="text-[10px] text-gray-500 pl-1 truncate">{port.label}</span>
              <span
                className="ml-auto text-[8px] px-1.5 py-0.5 rounded-full font-mono"
                style={{
                  background: `${DATA_TYPE_COLORS[port.dataType] || '#94a3b8'}15`,
                  color: DATA_TYPE_COLORS[port.dataType] || '#94a3b8',
                  border: `1px solid ${DATA_TYPE_COLORS[port.dataType] || '#94a3b8'}30`,
                }}
              >
                {port.dataType}
              </span>
            </div>
          ))}

          {/* Divider if both inputs and outputs */}
          {nodeData.inputs.length > 0 && nodeData.outputs.length > 0 && (
            <div className="border-t border-gray-100 my-1" />
          )}

          {/* Output ports */}
          {nodeData.outputs.map((port) => (
            <div
              key={port.id}
              className="flex items-center gap-2 relative justify-end"
              style={{ minHeight: '22px' }}
            >
              <span
                className="text-[8px] px-1.5 py-0.5 rounded-full font-mono"
                style={{
                  background: `${DATA_TYPE_COLORS[port.dataType] || '#94a3b8'}15`,
                  color: DATA_TYPE_COLORS[port.dataType] || '#94a3b8',
                  border: `1px solid ${DATA_TYPE_COLORS[port.dataType] || '#94a3b8'}30`,
                }}
              >
                {port.dataType}
              </span>
              <span className="text-[10px] text-gray-500 pr-1 truncate">{port.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                style={{
                  right: -17,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 10,
                  height: 10,
                  background: DATA_TYPE_COLORS[port.dataType] || '#94a3b8',
                  border: '2px solid white',
                  borderRadius: '50%',
                  boxShadow: `0 0 0 2px ${DATA_TYPE_COLORS[port.dataType] || '#94a3b8'}40`,
                }}
              />
            </div>
          ))}

          {/* Show key config values */}
          {Object.keys(nodeData.config).slice(0, 2).map(key => {
            const val = nodeData.config[key];
            if (typeof val === 'object') return null;
            return (
              <div
                key={key}
                className="flex items-center gap-1 mt-1 px-2 py-1 rounded-lg"
                style={{ background: `${color}08` }}
              >
                <span className="text-[9px] text-gray-400 capitalize">{key}:</span>
                <span className="text-[9px] font-mono text-gray-600 truncate">{String(val)}</span>
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

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { CATEGORY_META, type NodeCategory, type NodeTemplate, NODE_TEMPLATES } from '../../store/nodeEditorStore';

interface NodePaletteProps {
  onAddNode: (template: NodeTemplate) => void;
}

export default function NodePalette({ onAddNode }: NodePaletteProps) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<NodeCategory | null>('input');

  const categories = Object.keys(CATEGORY_META) as NodeCategory[];
  const filtered = NODE_TEMPLATES.filter(t =>
    !search ||
    t.label.toLowerCase().includes(search.toLowerCase()) ||
    t.description.toLowerCase().includes(search.toLowerCase())
  );

  const grouped = categories.reduce((acc, cat) => {
    acc[cat] = filtered.filter(t => t.category === cat);
    return acc;
  }, {} as Record<NodeCategory, NodeTemplate[]>);

  return (
    <div className="w-64 bg-white dark:bg-slate-800 border-r border-gray-200 dark:border-slate-700 flex flex-col h-full overflow-hidden shrink-0">
      {/* Header */}
      <div className="p-3 border-b border-gray-100 dark:border-slate-700">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Node Palette</p>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search nodes..."
          className="w-full px-3 py-2 text-xs bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all"
        />
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1 custom-scrollbar">
        {categories.map(cat => {
          const meta = CATEGORY_META[cat];
          const templates = grouped[cat];
          if (templates.length === 0) return null;
          const isExpanded = expanded === cat || search.length > 0;

          return (
            <div key={cat}>
              <button
                onClick={() => setExpanded(isExpanded && !search ? null : cat)}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-xl hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-all text-xs font-bold"
                style={{ color: meta.color }}
              >
                <span className="text-sm">{meta.icon}</span>
                <span>{meta.label}</span>
                <span className="ml-auto text-[10px] text-gray-400 font-normal">{templates.length}</span>
                {isExpanded
                  ? <ChevronDown className="w-3 h-3 text-gray-400" />
                  : <ChevronRight className="w-3 h-3 text-gray-400" />
                }
              </button>

              {isExpanded && (
                <div className="space-y-0.5 mt-0.5 mb-1 ml-0.5">
                  {templates.map(template => (
                    <button
                      key={template.type}
                      onClick={() => onAddNode(template)}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/nodetemplate', template.type);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl cursor-pointer transition-all group hover:bg-gray-50 dark:hover:bg-slate-700/50 border border-transparent hover:border-gray-200 dark:hover:border-slate-600 text-left"
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0 transition-transform group-hover:scale-110"
                        style={{
                          backgroundColor: `${template.color}15`,
                          border: `1px solid ${template.color}25`,
                        }}
                      >
                        {template.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold text-gray-700 dark:text-gray-300 truncate">
                          {template.label}
                        </p>
                        <p className="text-[9px] text-gray-400 truncate leading-tight mt-0.5">
                          {template.description}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="p-3 border-t border-gray-100 dark:border-slate-700">
        <p className="text-[9px] text-gray-400 text-center">
          Click or drag to add nodes to canvas
        </p>
      </div>
    </div>
  );
}

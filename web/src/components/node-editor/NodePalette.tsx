import { useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { CATEGORY_META, type NodeCategory, type NodeTemplate, NODE_TEMPLATES } from '../../store/nodeEditorStore';
import { Glyph } from '../ui/Glyph';

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
    <div className="w-60 bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-800 flex flex-col h-full overflow-hidden shrink-0">
      {/* Header */}
      <div className="p-3 border-b border-gray-200 dark:border-slate-800">
        <p className="ui-eyebrow mb-2">Nodos disponibles</p>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar nodos..."
            className="ui-input pl-8 py-1.5 text-xs"
          />
        </div>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {categories.map(cat => {
          const meta = CATEGORY_META[cat];
          const templates = grouped[cat];
          if (templates.length === 0) return null;
          const isExpanded = expanded === cat || search.length > 0;

          return (
            <div key={cat}>
              <button
                onClick={() => setExpanded(isExpanded && !search ? null : cat)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors text-xs font-medium text-gray-700 dark:text-gray-200"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: meta.color }} />
                <span>{meta.label}</span>
                <span className="ml-auto text-[11px] font-mono text-gray-400">{templates.length}</span>
                {isExpanded
                  ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                  : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
                }
              </button>

              {isExpanded && (
                <div className="space-y-0.5 mt-0.5 mb-1.5 pl-2">
                  {templates.map(template => (
                    <button
                      key={template.type}
                      onClick={() => onAddNode(template)}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/nodetemplate', template.type);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors group hover:bg-gray-50 dark:hover:bg-slate-800/70 border border-transparent hover:border-gray-200 dark:hover:border-slate-700 text-left"
                    >
                      <div
                        className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-gray-300"
                        style={{ borderLeft: `2px solid ${template.color}` }}
                      >
                        <Glyph name={template.icon} className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                          {template.label}
                        </p>
                        <p className="text-[11px] text-gray-500 truncate leading-tight">
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
      <div className="p-2.5 border-t border-gray-200 dark:border-slate-800">
        <p className="text-[11px] text-gray-400 text-center">
          Clic o arrastrar al lienzo
        </p>
      </div>
    </div>
  );
}

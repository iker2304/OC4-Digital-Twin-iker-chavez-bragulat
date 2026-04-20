import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { X, Settings2, Terminal, Trash2, Pause, Play } from 'lucide-react';
import { useNodeEditorStore } from '../../../store/nodeEditorStore';

interface TerminalNodeData {
  type: string;
  category: string;
  label: string;
  icon: string;
  color: string;
  inputs: { id: string; label: string; dataType: string }[];
  outputs: { id: string; label: string; dataType: string }[];
  config: {
    maxMessages?: number;
    showTimestamp?: boolean;
    label?: string;
    pollInterval?: number;
  };
  [key: string]: unknown;
}

interface TerminalLine {
  id: number;
  text: string;
  ts: string;
  topic?: string;
  isJson?: boolean;
}

const BASE_URL = 'http://localhost:8080';

let _lineId = 0;
const nextId = () => ++_lineId;

const TerminalNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData = data as TerminalNodeData;
  const { removeSelectedNode, selectNode, edges, nodes } = useNodeEditorStore();

  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [msgCount, setMsgCount] = useState(0);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const bottomRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const accentColor = '#22d3ee'; // cyan

  const maxLines = nodeData.config?.maxMessages ?? 100;
  const showTimestamp = nodeData.config?.showTimestamp ?? true;
  const pollInterval = nodeData.config?.pollInterval ?? 1000;

  // ── Determine upstream source type ──
  // Find edges where this node is the target
  const incomingEdgeSource = (() => {
    const inEdge = edges.find(e => e.target === id);
    if (!inEdge) return null;
    const sourceNode = nodes.find(n => n.id === inEdge.source);
    return sourceNode ? (sourceNode.data as { type?: string }).type ?? null : null;
  })();

  const isMqttSource = incomingEdgeSource === 'mqtt_subscribe';

  const addLine = useCallback(
    (text: string, topic?: string, ts?: string) => {
      if (pausedRef.current) return;
      const isJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
      setLines(prev => {
        const newLine: TerminalLine = {
          id: nextId(),
          text,
          ts: ts ?? new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }),
          topic,
          isJson,
        };
        const updated = [...prev, newLine];
        return updated.length > maxLines ? updated.slice(-maxLines) : updated;
      });
      setMsgCount(c => c + 1);
    },
    [maxLines],
  );

  // ── Auto-scroll ──
  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, paused]);

  // ── SSE stream for MQTT source ──
  useEffect(() => {
    if (!isMqttSource) return;

    // Find the mqtt_subscribe node config
    const inEdge = edges.find(e => e.target === id);
    if (!inEdge) return;
    const srcNode = nodes.find(n => n.id === inEdge.source);
    if (!srcNode) return;
    const cfg = (srcNode.data as { config?: Record<string, unknown> }).config ?? {};
    const broker = String(cfg.broker ?? 'localhost');
    const port = Number(cfg.port ?? 1883);
    const topic = String(cfg.topic ?? '#');
    const qos = Number(cfg.qos ?? 0);
    const srcId = inEdge.source;

    // Close any existing stream
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const url = `${BASE_URL}/api/mqtt/stream/${srcId}?broker=${encodeURIComponent(broker)}&port=${port}&topic=${encodeURIComponent(topic)}&qos=${qos}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('mqtt_message', (e) => {
      try {
        const msg = JSON.parse((e as MessageEvent).data);
        const payloadStr =
          typeof msg.payload === 'string'
            ? msg.payload
            : JSON.stringify(msg.payload, null, 2);
        addLine(payloadStr, msg.topic, msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }) : undefined);
      } catch {
        addLine((e as MessageEvent).data);
      }
    });

    es.addEventListener('status', (e) => {
      try {
        const s = JSON.parse((e as MessageEvent).data);
        setConnected(Boolean(s.connected));
        addLine(`[CONNECTED] broker=${s.broker}:${s.port} topic=${s.topic}`);
      } catch { /* ignore */ }
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isMqttSource, edges, nodes]);

  // ── Poll endpoint for non-MQTT (terminal_output from flow executor) ──
  useEffect(() => {
    if (isMqttSource) return;

    if (pollRef.current) clearInterval(pollRef.current);

    let lastCount = 0;
    const poll = async () => {
      if (pausedRef.current) return;
      try {
        const res = await fetch(`${BASE_URL}/api/flow/terminal/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        const allLines: string[] = data.lines ?? [];
        if (allLines.length > lastCount) {
          const newOnes = allLines.slice(lastCount);
          newOnes.forEach(l => addLine(l));
          lastCount = allLines.length;
          setConnected(true);
        }
      } catch {
        setConnected(false);
      }
    };

    pollRef.current = setInterval(poll, pollInterval);
    poll(); // immediate first poll

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [id, isMqttSource, pollInterval, addLine]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      selectNode(id);
      removeSelectedNode();
    },
    [id, removeSelectedNode, selectNode],
  );

  const handleConfig = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      selectNode(id);
    },
    [id, selectNode],
  );

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLines([]);
    setMsgCount(0);
  }, []);

  const handlePause = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setPaused(p => !p);
  }, []);

  return (
    <div
      className={`transition-all duration-200 ${selected ? 'scale-[1.01]' : ''}`}
      style={{
        width: 380,
        filter: selected
          ? `drop-shadow(0 0 14px ${accentColor}50)`
          : `drop-shadow(0 4px 12px rgba(0,0,0,0.3))`,
      }}
    >
      <div
        className="rounded-2xl border-2"
        style={{
          borderColor: selected ? accentColor : `${accentColor}40`,
          background: '#0f172a',
          overflow: 'visible',
        }}
      >
        {/* Accent bar — also clips the top corners */}
        <div className="h-1 rounded-t-2xl" style={{ background: `linear-gradient(90deg, ${accentColor}, #818cf8)` }} />

        {/* Header */}
        <div
          className="px-3 py-2 flex items-center gap-2 cursor-grab active:cursor-grabbing"
          style={{ background: '#1e293b' }}
        >
          <Terminal className="w-4 h-4 shrink-0" style={{ color: accentColor }} />
          <span className="text-xs font-bold flex-1 text-white/90 truncate">
            {nodeData.config?.label || nodeData.label || 'Terminal Output'}
          </span>

          {/* Status dot */}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: connected ? '#22c55e' : '#f87171' }}
            title={connected ? 'Connected' : 'Disconnected'}
          />

          {/* Message count */}
          <span className="text-[9px] font-mono text-slate-400 shrink-0">{msgCount} msg</span>

          <button onClick={handlePause} className="p-1 rounded-lg hover:bg-white/10 transition-all" title={paused ? 'Resume' : 'Pause'}>
            {paused ? (
              <Play className="w-3 h-3 text-yellow-400" />
            ) : (
              <Pause className="w-3 h-3 text-slate-400 hover:text-yellow-400" />
            )}
          </button>
          <button onClick={handleClear} className="p-1 rounded-lg hover:bg-white/10 transition-all" title="Clear">
            <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-400" />
          </button>
          <button onClick={handleConfig} className="p-1 rounded-lg hover:bg-white/10 transition-all" title="Configure">
            <Settings2 className="w-3 h-3 text-slate-400" style={{ color: `${accentColor}90` }} />
          </button>
          <button onClick={handleDelete} className="p-1 rounded-lg hover:bg-red-500/20 transition-all group" title="Delete">
            <X className="w-3 h-3 text-slate-500 group-hover:text-red-400" />
          </button>
        </div>

        {/* Terminal body */}
        <div
          className="overflow-y-auto font-mono text-[10px] leading-relaxed px-2 py-1.5 space-y-px"
          style={{ height: 220, background: '#020617' }}
        >
          {lines.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <span className="text-slate-600 text-[10px]">
                {isMqttSource ? 'Waiting for MQTT messages…' : 'Waiting for data…'}
              </span>
            </div>
          ) : (
            lines.map(line => <TerminalLine key={line.id} line={line} showTimestamp={showTimestamp} />)
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input handle row — overflow: visible so the pin escapes the card */}
        <div
          className="px-3 py-1.5 border-t border-slate-800 flex items-center gap-1.5 relative rounded-b-2xl"
          style={{ minHeight: 26, overflow: 'visible' }}
        >
          <Handle
            type="target"
            position={Position.Left}
            id="input"
            style={{
              position: 'absolute',
              left: -6,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 12,
              height: 12,
              background: accentColor,
              border: '2px solid #0f172a',
              borderRadius: '50%',
              boxShadow: `0 0 0 2px ${accentColor}40`,
              zIndex: 10,
            }}
          />
          <span className="text-[9px] text-slate-500 pl-3">input · any</span>
          {paused && (
            <span className="ml-auto text-[9px] text-yellow-400 font-bold animate-pulse">PAUSED</span>
          )}
        </div>
      </div>
    </div>
  );
});

TerminalNode.displayName = 'TerminalNode';

export default TerminalNode;

// ── Sub-component: individual terminal line ──
function TerminalLine({ line, showTimestamp }: { line: TerminalLine; showTimestamp: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const isJson = line.isJson;
  const isSystem = line.text.startsWith('[') && (
    line.text.includes('CONNECTED') ||
    line.text.includes('no data') ||
    line.text.includes('ERROR')
  );

  let color = '#94a3b8';
  if (isSystem) color = '#64748b';
  else if (isJson) color = '#a5f3fc';
  else color = '#e2e8f0';

  const formatted = isJson && expanded
    ? (() => {
        try { return JSON.stringify(JSON.parse(line.text), null, 2); }
        catch { return line.text; }
      })()
    : line.text;

  return (
    <div
      className="flex gap-1.5 items-start group hover:bg-white/5 rounded px-1 cursor-default"
      style={{ color }}
      onClick={() => isJson && setExpanded(e => !e)}
    >
      {showTimestamp && (
        <span className="text-slate-600 shrink-0 select-none" style={{ fontSize: 9 }}>
          {line.ts}
        </span>
      )}
      {line.topic && (
        <span className="text-cyan-700 shrink-0 truncate max-w-[80px]" style={{ fontSize: 9 }} title={line.topic}>
          {line.topic}
        </span>
      )}
      <span
        className={`break-all whitespace-pre-wrap flex-1 ${isJson ? 'cursor-pointer' : ''}`}
        style={{ fontSize: 10 }}
      >
        {formatted}
        {isJson && !expanded && (
          <span className="text-slate-600 ml-1" style={{ fontSize: 9 }}>[expand]</span>
        )}
      </span>
    </div>
  );
}

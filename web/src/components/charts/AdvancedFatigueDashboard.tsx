import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ComposedChart, LineChart, ScatterChart, Scatter, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { Filter, AlertTriangle, FileJson, FileSpreadsheet, Activity } from 'lucide-react';

interface StructuralHistory {
  timestamp: number;
  mooringTension: number;
  towerStress: number;
  fatigueLife: number;
}

interface AdvancedFatigueDashboardProps {
  history: StructuralHistory[];
  config?: FatigueDashboardConfig;
}

export interface FatigueDashboardConfig {
  refreshRateMs: number;
  maxPoints: number;
  thresholds: {
    warning: number;
    critical: number;
  };
  colorScale: {
    low: string;
    mid: string;
    high: string;
  };
  normalization: {
    min: number;
    max: number;
    logScaleOrderThreshold: number;
    epsilon: number;
  };
  heatmap: {
    columns: number;
    legendTicks: number;
  };
  fit: {
    paddingPercent: number;
    minimumPadding: number;
  };
}

const DEFAULT_CONFIG: FatigueDashboardConfig = {
  refreshRateMs: 250,
  maxPoints: 100,
  thresholds: {
    warning: 70,
    critical: 90
  },
  colorScale: {
    low: '#10b981',
    mid: '#f59e0b',
    high: '#ef4444'
  },
  normalization: {
    min: 0,
    max: 1,
    logScaleOrderThreshold: 2,
    epsilon: 1e-6
  },
  heatmap: {
    columns: 24,
    legendTicks: 5
  },
  fit: {
    paddingPercent: 0.06,
    minimumPadding: 0.01
  }
}

interface HeatmapCellData {
  element: string;
  row: number;
  col: number;
  cycle: number;
  coordinate: string;
  rawDamagePercent: number;
  normalized: number;
}

interface HeatmapSeriesSummary {
  displayMinPercent: number;
  displayMaxPercent: number;
  startCycle: number;
  endCycle: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const isFiniteNumber = (value: number) => Number.isFinite(value);

const mergeConfig = (config?: FatigueDashboardConfig): FatigueDashboardConfig => {
  if (!config) return DEFAULT_CONFIG;
  return {
    refreshRateMs: config.refreshRateMs ?? DEFAULT_CONFIG.refreshRateMs,
    maxPoints: config.maxPoints ?? DEFAULT_CONFIG.maxPoints,
    thresholds: {
      warning: config.thresholds?.warning ?? DEFAULT_CONFIG.thresholds.warning,
      critical: config.thresholds?.critical ?? DEFAULT_CONFIG.thresholds.critical
    },
    colorScale: {
      low: config.colorScale?.low ?? DEFAULT_CONFIG.colorScale.low,
      mid: config.colorScale?.mid ?? DEFAULT_CONFIG.colorScale.mid,
      high: config.colorScale?.high ?? DEFAULT_CONFIG.colorScale.high
    },
    normalization: {
      min: config.normalization?.min ?? DEFAULT_CONFIG.normalization.min,
      max: config.normalization?.max ?? DEFAULT_CONFIG.normalization.max,
      logScaleOrderThreshold: config.normalization?.logScaleOrderThreshold ?? DEFAULT_CONFIG.normalization.logScaleOrderThreshold,
      epsilon: config.normalization?.epsilon ?? DEFAULT_CONFIG.normalization.epsilon
    },
    heatmap: {
      columns: config.heatmap?.columns ?? DEFAULT_CONFIG.heatmap.columns,
      legendTicks: config.heatmap?.legendTicks ?? DEFAULT_CONFIG.heatmap.legendTicks
    },
    fit: {
      paddingPercent: config.fit?.paddingPercent ?? DEFAULT_CONFIG.fit.paddingPercent,
      minimumPadding: config.fit?.minimumPadding ?? DEFAULT_CONFIG.fit.minimumPadding
    }
  };
};

const generateSNCurve = (element: string) => {
  const data: { stress: number; cycles: number }[] = [];
  const logA = element === 'Mooring' ? 11.5 : 12.18; // Different elements, different curves
  const m = 3.0;
  for (let stress = 4000; stress >= 1; stress = stress * 0.8) {
    const logN = logA - m * Math.log10(stress);
    data.push({ stress, cycles: Math.pow(10, logN) });
  }
  return data.sort((a, b) => a.cycles - b.cycles);
};

const parseHexColor = (hex: string) => {
  const normalized = hex.replace('#', '');
  const fullHex = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized;
  const safeHex = fullHex.padEnd(6, '0').slice(0, 6);
  const r = parseInt(safeHex.slice(0, 2), 16);
  const g = parseInt(safeHex.slice(2, 4), 16);
  const b = parseInt(safeHex.slice(4, 6), 16);
  return { r, g, b };
};

const mixColor = (from: string, to: string, t: number) => {
  const start = parseHexColor(from);
  const end = parseHexColor(to);
  const ratio = clamp(t, 0, 1);
  const r = Math.round(start.r + (end.r - start.r) * ratio);
  const g = Math.round(start.g + (end.g - start.g) * ratio);
  const b = Math.round(start.b + (end.b - start.b) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
};

const getContinuousColor = (t: number, low: string, mid: string, high: string) => {
  if (t <= 0.5) return mixColor(low, mid, t * 2);
  return mixColor(mid, high, (t - 0.5) * 2);
};

const getDomainWithPadding = (values: number[], paddingPercent: number, minimumPadding: number) => {
  const filtered = values.filter(isFiniteNumber);
  if (filtered.length === 0) return [0, 1] as [number, number];
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * paddingPercent, minimumPadding);
    return [min - pad, max + pad] as [number, number];
  }
  const range = max - min;
  const pad = Math.max(range * paddingPercent, minimumPadding);
  return [min - pad, max + pad] as [number, number];
};

const sanitizeSeries = (series: number[]) => {
  return series.map((value, index) => {
    if (isFiniteNumber(value)) return value;
    for (let i = index - 1; i >= 0; i--) {
      if (isFiniteNumber(series[i])) return series[i];
    }
    for (let i = index + 1; i < series.length; i++) {
      if (isFiniteNumber(series[i])) return series[i];
    }
    return 0;
  });
};

export default function AdvancedFatigueDashboard({ history, config }: AdvancedFatigueDashboardProps) {
  const mergedConfig = useMemo(() => mergeConfig(config), [config]);
  const [selectedElement, setSelectedElement] = useState('Tower Base');
  const [loadType, setLoadType] = useState('All');
  const [manualThresholds, setManualThresholds] = useState<{ warning: number; critical: number } | null>(null);
  const [renderHistory, setRenderHistory] = useState(history);
  const [resizeToken, setResizeToken] = useState(0);
  const [heatmapSize, setHeatmapSize] = useState({ width: 0, height: 0 });
  const [hoveredCell, setHoveredCell] = useState<HeatmapCellData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const heatmapRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef(history);

  const warningThreshold = manualThresholds?.warning ?? mergedConfig.thresholds.warning;
  const criticalThreshold = manualThresholds?.critical ?? mergedConfig.thresholds.critical;

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    let isActive = true;
    let rafId = 0;
    let lastCommit = 0;
    const tick = (timestamp: number) => {
      if (!isActive) return;
      if (timestamp - lastCommit >= mergedConfig.refreshRateMs) {
        const next = historyRef.current.slice(-Math.max(20, mergedConfig.maxPoints));
        setRenderHistory((prev) => {
          const prevLast = prev[prev.length - 1];
          const nextLast = next[next.length - 1];
          const unchanged = prev.length === next.length && prevLast?.timestamp === nextLast?.timestamp;
          return unchanged ? prev : next;
        });
        lastCommit = timestamp;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      isActive = false;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [mergedConfig.maxPoints, mergedConfig.refreshRateMs]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => setResizeToken((value) => value + 1));
    });
    if (containerRef.current) observer.observe(containerRef.current);
    const onResize = () => setResizeToken((value) => value + 1);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setHeatmapSize({ width, height });
    });
    if (heatmapRef.current) observer.observe(heatmapRef.current);
    return () => observer.disconnect();
  }, []);

  const validHistory = useMemo(() => {
    const filteredByLoad = renderHistory.filter((item) => {
      if (loadType === 'Wave') return item.timestamp % 2 === 0;
      if (loadType === 'Wind') return item.timestamp % 2 !== 0;
      return true;
    });
    return filteredByLoad.filter((item) =>
      item.towerStress > 0 && item.towerStress < 2000 &&
      item.mooringTension >= 0 && item.fatigueLife >= 0
    );
  }, [loadType, renderHistory]);

  const elementDefinitions = useMemo(() => [
    { element: 'Tower Base', factor: 1, coordinate: 'Z=0m' },
    { element: 'Transition Piece', factor: 0.85, coordinate: 'Z=10m' },
    { element: 'Mooring Fairlead', factor: 1.18, coordinate: 'Z=-14m' },
    { element: 'Pontoon Joint', factor: 0.62, coordinate: 'Z=-20m' }
  ], []);

  const heatmapData = useMemo(() => {
    const latestFatiguePercent = validHistory.length > 0
      ? validHistory[validHistory.length - 1].fatigueLife
      : 0;
    return elementDefinitions.map((definition) => {
      const damagePercent = clamp(latestFatiguePercent * definition.factor, 0, 100);
      return {
        element: definition.element,
        damagePercent,
        coordinate: definition.coordinate
      };
    });
  }, [elementDefinitions, validHistory]);

  const heatmapCells = useMemo(() => {
    const columnCount = mergedConfig.heatmap.columns;
    const rows = elementDefinitions.length;
    const historySlice = validHistory.slice(-columnCount);
    const visibleColumns = Math.max(1, historySlice.length);
    const normalizedRawMin = mergedConfig.normalization.min;
    const normalizedRawMax = mergedConfig.normalization.max;
    const epsilon = mergedConfig.normalization.epsilon;
    const denominator = Math.max(epsilon, normalizedRawMax - normalizedRawMin);

    const rawMatrix = elementDefinitions.map((definition) => {
      const values = historySlice.map((sample) => (sample.fatigueLife * definition.factor) / 100);
      const safeValues = sanitizeSeries(values);
      return safeValues.map((value) => clamp((value - normalizedRawMin) / denominator, 0, 1));
    });

    const flatValues = rawMatrix.flat();
    const absoluteMin = flatValues.length > 0 ? Math.min(...flatValues) : 0;
    const absoluteMax = flatValues.length > 0 ? Math.max(...flatValues) : 1;
    const adaptiveRange = Math.max(epsilon, absoluteMax - absoluteMin);
    const adaptiveMin = absoluteMin;
    const adaptiveMax = absoluteMax;
    const positiveValues = flatValues.map((value) => clamp(value, epsilon, 1)).filter((value) => value > epsilon);
    const minPositive = positiveValues.length > 0 ? Math.min(...positiveValues) : epsilon;
    const maxPositive = positiveValues.length > 0 ? Math.max(...positiveValues) : 1;
    const orderMagnitude = Math.log10(maxPositive / Math.max(minPositive, epsilon));
    const useLogScale = orderMagnitude > mergedConfig.normalization.logScaleOrderThreshold;

    const normalizeValue = (value: number) => {
      const clamped = clamp(value, adaptiveMin, adaptiveMax);
      if (!useLogScale) return clamp((clamped - adaptiveMin) / adaptiveRange, 0, 1);
      const minLog = Math.log10(minPositive);
      const maxLog = Math.log10(maxPositive);
      const valueLog = Math.log10(clamp(clamped, epsilon, 1));
      if (maxLog === minLog) return clamp((clamped - adaptiveMin) / adaptiveRange, 0, 1);
      return clamp((valueLog - minLog) / (maxLog - minLog), 0, 1);
    };

    const cells: HeatmapCellData[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < visibleColumns; col++) {
        const raw = rawMatrix[row][col] ?? 0;
        const normalized = normalizeValue(raw);
        const historyIndex = validHistory.length - visibleColumns + col;
        const cycle = Math.max(0, historyIndex + 1) * 100;
        cells.push({
          element: elementDefinitions[row].element,
          row,
          col,
          cycle,
          coordinate: elementDefinitions[row].coordinate,
          rawDamagePercent: raw * 100,
          normalized
        });
      }
    }
    const startCycle = Math.max(100, (validHistory.length - visibleColumns + 1) * 100);
    const endCycle = Math.max(startCycle, validHistory.length * 100);
    return {
      cells,
      useLogScale,
      rows,
      columns: visibleColumns,
      summary: {
        displayMinPercent: adaptiveMin * 100,
        displayMaxPercent: adaptiveMax * 100,
        startCycle,
        endCycle
      } as HeatmapSeriesSummary
    };
  }, [elementDefinitions, mergedConfig.heatmap.columns, mergedConfig.normalization.epsilon, mergedConfig.normalization.logScaleOrderThreshold, mergedConfig.normalization.max, mergedConfig.normalization.min, validHistory]);

  const scfData = useMemo(() => {
    const startCycle = Math.max(0, validHistory.length - mergedConfig.maxPoints) * 100;
    return validHistory.slice(-mergedConfig.maxPoints).map((item, index) => ({
      timestamp: item.timestamp,
      cycle: startCycle + (index + 1) * 100,
      scf: 1 + (item.towerStress / 500) + (item.mooringTension / 10000)
    }));
  }, [mergedConfig.maxPoints, validHistory]);

  const scatterData = useMemo(() => {
    const startCycle = Math.max(0, validHistory.length - mergedConfig.maxPoints) * 100;
    return validHistory.slice(-mergedConfig.maxPoints).map((item, index) => ({
      cycles: startCycle + (index + 1) * 100,
      maxStress: item.towerStress
    }));
  }, [mergedConfig.maxPoints, validHistory]);

  const snData = useMemo(() => generateSNCurve(selectedElement), [selectedElement]);
  const currentStatus = useMemo(() => {
    if (validHistory.length === 0) return [];
    const cycles = validHistory.length * 100;
    return [{
      cycles,
      stress: validHistory[validHistory.length - 1].towerStress
    }];
  }, [validHistory]);

  const scfDomain = useMemo(
    () => getDomainWithPadding(scfData.map((item) => item.scf), mergedConfig.fit.paddingPercent, mergedConfig.fit.minimumPadding),
    [mergedConfig.fit.minimumPadding, mergedConfig.fit.paddingPercent, scfData]
  );
  const scatterXDomain = useMemo(
    () => getDomainWithPadding(scatterData.map((item) => item.cycles), mergedConfig.fit.paddingPercent, 100),
    [mergedConfig.fit.paddingPercent, scatterData]
  );
  const scatterYDomain = useMemo(
    () => getDomainWithPadding(scatterData.map((item) => item.maxStress), mergedConfig.fit.paddingPercent, mergedConfig.fit.minimumPadding),
    [mergedConfig.fit.minimumPadding, mergedConfig.fit.paddingPercent, scatterData]
  );

  const exportData = (format: 'csv' | 'json') => {
    if (validHistory.length === 0) return;
    const dataToExport = validHistory.map(d => ({
      time: new Date(d.timestamp).toISOString(),
      stress_MPa: d.towerStress,
      tension_kN: d.mooringTension,
      fatigue_percent: d.fatigueLife
    }));

    let content = '';
    let type = '';
    let ext = '';

    if (format === 'json') {
      content = JSON.stringify(dataToExport, null, 2);
      type = 'application/json';
      ext = 'json';
    } else {
      const headers = Object.keys(dataToExport[0]).join(',');
      const rows = dataToExport.map(obj => Object.values(obj).join(',')).join('\n');
      content = `${headers}\n${rows}`;
      type = 'text/csv';
      ext = 'csv';
    }

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shm_fatigue_export.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getThresholdColor = (damagePercent: number) => {
    if (damagePercent >= criticalThreshold) return mergedConfig.colorScale.high;
    if (damagePercent >= warningThreshold) return mergedConfig.colorScale.mid;
    return mergedConfig.colorScale.low;
  };

  return (
    <div ref={containerRef} className="bg-white dark:bg-slate-900 rounded-xl p-4 border border-gray-200 dark:border-slate-700 shadow-sm col-span-full">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4 border-b border-gray-100 dark:border-slate-800 pb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-purple-500" />
            Advanced Fatigue Analysis (ASTM E466 / Eurocode 3)
          </h2>
          <p className="text-xs text-gray-500 mt-1">Real-time structural health monitoring and RUL estimation.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div className="flex items-center gap-2 bg-gray-50 dark:bg-slate-800 p-2 rounded-lg border border-gray-200 dark:border-slate-700">
            <Filter className="w-4 h-4 text-gray-400" />
            <select 
              className="bg-transparent text-gray-700 dark:text-gray-300 outline-none cursor-pointer"
              value={selectedElement}
              onChange={(e) => setSelectedElement(e.target.value)}
            >
              <option value="Tower Base">Tower Base</option>
              <option value="Transition Piece">Transition Piece</option>
              <option value="Mooring Fairlead">Mooring Fairlead</option>
            </select>
            <select
              className="bg-transparent text-gray-700 dark:text-gray-300 outline-none cursor-pointer border-l border-gray-300 dark:border-slate-600 pl-2"
              value={loadType}
              onChange={(e) => setLoadType(e.target.value)}
            >
              <option value="All">All Loads</option>
              <option value="Wave">Wave Dominated</option>
              <option value="Wind">Wind Dominated</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={() => exportData('csv')} className="flex items-center gap-1 px-3 py-2 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 rounded-lg transition-colors">
              <FileSpreadsheet className="w-4 h-4" /> CSV
            </button>
            <button onClick={() => exportData('json')} className="flex items-center gap-1 px-3 py-2 bg-purple-50 text-purple-600 hover:bg-purple-100 dark:bg-purple-900/30 dark:text-purple-400 rounded-lg transition-colors">
              <FileJson className="w-4 h-4" /> JSON
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <div className="bg-gray-50 dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex justify-between items-center">
              Remaining Useful Life (RUL)
              <span
                className="text-[10px] font-normal text-gray-500 cursor-pointer"
                onClick={() => {
                  const warningInput = prompt('Enter Warning Threshold (%)', warningThreshold.toString());
                  const criticalInput = prompt('Enter Critical Threshold (%)', criticalThreshold.toString());
                  const nextWarning = warningInput ? Number.parseFloat(warningInput) : warningThreshold;
                  const nextCritical = criticalInput ? Number.parseFloat(criticalInput) : criticalThreshold;
                  if (Number.isFinite(nextWarning) && Number.isFinite(nextCritical)) {
                    setManualThresholds({ warning: nextWarning, critical: nextCritical });
                  }
                }}
              >
                ⚙️ Config Thresholds
              </span>
            </h3>
            {heatmapData.map((item) => (
              <div key={item.element} className="mb-3 last:mb-0">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-600 dark:text-gray-400">{item.element} · {item.coordinate}</span>
                  <span className="font-mono font-bold" style={{ color: getThresholdColor(item.damagePercent) }}>
                    {item.damagePercent.toFixed(2)}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-slate-700 rounded-full h-1.5 overflow-hidden flex">
                  <div
                    className="h-full transition-all duration-500"
                    style={{ width: `${Math.min(100, item.damagePercent)}%`, backgroundColor: getThresholdColor(item.damagePercent) }}
                  />
                </div>
                {item.damagePercent >= criticalThreshold && (
                  <p className="text-[10px] text-red-500 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3"/> Critical fatigue limit reached</p>
                )}
              </div>
            ))}
          </div>

          <div ref={heatmapRef} className="h-72 bg-gray-50 dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Damage Heatmap</h3>
            <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-2">
              Filas = zonas estructurales · Columnas = ciclos recientes · Color = daño acumulado relativo en ventana visible
            </p>
            <div className="grid grid-cols-[140px_1fr] gap-3 h-[calc(100%-48px)]">
              <div className="flex flex-col justify-between text-xs text-gray-500 dark:text-gray-400">
                {elementDefinitions.map((item) => (
                  <div key={item.element} className="leading-tight">
                    <div>{item.element}</div>
                    <div className="text-[10px] opacity-70">{item.coordinate}</div>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <div
                  className="grid gap-[3px]"
                  style={{
                    gridTemplateColumns: `repeat(${heatmapCells.columns}, ${Math.max(10, Math.floor((heatmapSize.width / Math.max(1, heatmapCells.columns)) * (window.devicePixelRatio || 1)) / (window.devicePixelRatio || 1))}px`,
                    gridTemplateRows: `repeat(${heatmapCells.rows}, 1fr)`
                  }}
                >
                  {heatmapCells.cells.map((cell) => (
                    <button
                      key={`${cell.element}-${cell.row}-${cell.col}`}
                      className="rounded-[2px] w-full h-8 transition-opacity hover:opacity-80"
                      style={{
                        backgroundColor: getContinuousColor(
                          cell.normalized,
                          mergedConfig.colorScale.low,
                          mergedConfig.colorScale.mid,
                          mergedConfig.colorScale.high
                        )
                      }}
                      onMouseEnter={() => setHoveredCell(cell)}
                      onFocus={() => setHoveredCell(cell)}
                      onMouseLeave={() => setHoveredCell((current) => (current?.element === cell.element && current.col === cell.col ? null : current))}
                      aria-label={`${cell.element} cycle ${cell.cycle} damage ${cell.rawDamagePercent.toFixed(3)}%`}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3">
              <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400 mb-1">
                <span>Scale: {heatmapCells.useLogScale ? 'log' : 'linear'}</span>
                <span>{heatmapCells.summary.displayMinPercent.toFixed(2)}% → {heatmapCells.summary.displayMaxPercent.toFixed(2)}% (ventana)</span>
              </div>
              <div className="h-2 rounded overflow-hidden" style={{ background: `linear-gradient(to right, ${mergedConfig.colorScale.low}, ${mergedConfig.colorScale.mid}, ${mergedConfig.colorScale.high})` }} />
              <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                {Array.from({ length: mergedConfig.heatmap.legendTicks }).map((_, index) => {
                  const ratio = index / Math.max(1, mergedConfig.heatmap.legendTicks - 1);
                  const value = heatmapCells.summary.displayMinPercent + (heatmapCells.summary.displayMaxPercent - heatmapCells.summary.displayMinPercent) * ratio;
                  return <span key={index}>{value.toFixed(2)}%</span>;
                })}
              </div>
              <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                <span>Cycle {heatmapCells.summary.startCycle}</span>
                <span>Cycle {Math.round((heatmapCells.summary.startCycle + heatmapCells.summary.endCycle) / 2)}</span>
                <span>Cycle {heatmapCells.summary.endCycle}</span>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-gray-600 dark:text-gray-300">
              {hoveredCell ? `${hoveredCell.element} · ${hoveredCell.coordinate} · Cycle ${hoveredCell.cycle} · Damage ${hoveredCell.rawDamagePercent.toFixed(4)}%` : 'Hover over a cell to inspect coordinate, damage and cycle'}
            </div>
          </div>
        </div>

        <div className="h-96 bg-gray-50 dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700 lg:col-span-1">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">S-N Curve (Wöhler)</h3>
          <ResponsiveContainer key={`sn-${resizeToken}`} width="100%" height="90%">
            <ComposedChart data={snData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="cycles" type="number" scale="log" domain={[100, 10000000000]} tickFormatter={(t) => t.toExponential(0)} label={{ value: 'Cycles (N)', position: 'bottom', fill: '#94a3b8', fontSize: 11 }} tick={{ fill: '#94a3b8', fontSize: 10 }} />
              <YAxis dataKey="stress" type="number" scale="log" domain={[1, 1000]} label={{ value: 'Stress (MPa)', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }} tick={{ fill: '#94a3b8', fontSize: 10 }} />
              <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '12px' }} />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              <Line type="linear" dataKey="stress" name="Eurocode 3 Limit" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Scatter data={currentStatus} name="Current State" fill="#ef4444" shape="star" r={6} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="space-y-6 lg:col-span-1">
          <div className="h-44 bg-gray-50 dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Stress Concentration (SCF)</h3>
            <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-1">SCF &gt; 1.5 indica concentración elevada; SCF &gt; 2.0 crítico.</p>
            <ResponsiveContainer key={`scf-${resizeToken}`} width="100%" height="100%">
              <LineChart data={scfData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis dataKey="cycle" tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={(t) => `${(t / 1000).toFixed(0)}k`} />
                <YAxis domain={scfDomain} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={34} label={{ value: 'SCF [-]', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '12px' }} formatter={(value) => [`${Number(value ?? 0).toFixed(3)} [-]`, 'SCF']} labelFormatter={(label) => `Cycle ${label}`} />
                <ReferenceLine y={1.5} stroke="#f59e0b" strokeDasharray="4 4" />
                <ReferenceLine y={2} stroke="#ef4444" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="scf" stroke="#8b5cf6" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="h-44 bg-gray-50 dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Daily Max Stress vs Cycles</h3>
            <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-1">Cada punto es el máximo diario de tensión frente a los ciclos acumulados.</p>
            <ResponsiveContainer key={`scatter-${resizeToken}`} width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis type="number" dataKey="cycles" domain={scatterXDomain} name="Cycles" tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={(t) => `${(t / 1000).toFixed(1)}k`} label={{ value: 'Cycles [N]', position: 'insideBottom', fill: '#94a3b8', fontSize: 10 }} />
                <YAxis type="number" dataKey="maxStress" domain={scatterYDomain} name="Stress" unit="MPa" tick={{ fill: '#94a3b8', fontSize: 10 }} width={34} label={{ value: 'Max Stress [MPa]', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '12px' }} formatter={(value) => [`${Number(value ?? 0).toFixed(2)} MPa`, 'Daily Max Stress']} labelFormatter={(label) => `Cycle ${label}`} />
                <Scatter name="Load Cycles" data={scatterData} fill="#10b981" isAnimationActive={false} opacity={0.6} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

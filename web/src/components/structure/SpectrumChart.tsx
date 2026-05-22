/**
 * SpectrumChart.tsx — FFT Spectrum viewer for the Modal Explorer
 *
 * Renders the FFT amplitude spectrum received from /api/fem/modal-filtered-ws.
 * FEM modal frequencies are overlaid as clickable vertical markers.
 * Clicking a peak marker selects that mode in the modalStore, triggering
 * the harmonic oscillation animation in FemMeshViewer.
 */
import { useCallback, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Label
} from 'recharts';
import { useModalStore, FEM_MODAL_FREQUENCIES } from '../../store/modalStore';
import { findModalPeaks } from '../../lib/femUtils';

// ── Constants ─────────────────────────────────────────────────────────────────

const SPECTRUM_MAX_POINTS = 256; // downsample for performance

// ── Custom tooltip ────────────────────────────────────────────────────────────

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900/90 border border-cyan-500/30 rounded-lg px-3 py-2 text-xs">
      <p className="text-cyan-400 font-mono">{`${Number(label).toFixed(3)} Hz`}</p>
      <p className="text-white/70">{`Amp: ${Number(payload[0]?.value).toExponential(3)}`}</p>
    </div>
  );
};

// ── Component ─────────────────────────────────────────────────────────────────

export const SpectrumChart = () => {
  const fftSpectrum  = useModalStore((s) => s.fftSpectrum);
  const selectedMode = useModalStore((s) => s.selectedModeId);
  const selectMode   = useModalStore((s) => s.selectMode);

  // ── Downsample spectrum for Recharts ─────────────────────────────────────
  const chartData = useMemo(() => {
    if (!fftSpectrum) return [];
    const { freqs, magnitudes } = fftSpectrum;
    const step = Math.max(1, Math.floor(freqs.length / SPECTRUM_MAX_POINTS));
    const data = [];
    for (let i = 0; i < freqs.length; i += step) {
      data.push({ freq: freqs[i], mag: magnitudes[i] });
    }
    return data;
  }, [fftSpectrum]);

  // ── Find matching modal peaks in the spectrum ─────────────────────────────
  const modalPeaks = useMemo(() => {
    if (!fftSpectrum) return [];
    return findModalPeaks(
      fftSpectrum.freqs,
      fftSpectrum.magnitudes,
      FEM_MODAL_FREQUENCIES,
      0.5
    );
  }, [fftSpectrum]);

  const handleModeClick = useCallback((modeId: number) => {
    selectMode(selectedMode === modeId ? null : modeId);
  }, [selectedMode, selectMode]);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!fftSpectrum || chartData.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-2">
        <div className="text-3xl opacity-30">📊</div>
        <p className="text-sm">Esperando datos del espectro FFT…</p>
        <p className="text-xs opacity-60">Conéctese al sistema MQTT para ver el espectro</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Espectro FFT</h3>
          <p className="text-xs text-slate-400">
            Haz clic en un pico modal para animar ese modo
          </p>
        </div>
        {selectedMode && (
          <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-3 py-1 flex items-center gap-2">
            <span className="text-cyan-400 text-xs font-mono">
              Modo {selectedMode}
            </span>
            <span className="text-slate-300 text-xs font-mono">
              {FEM_MODAL_FREQUENCIES[selectedMode]?.toFixed(4)} Hz
            </span>
            <button
              onClick={() => selectMode(null)}
              className="text-slate-500 hover:text-white text-xs ml-1"
              title="Deseleccionar modo"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
            <defs>
              <linearGradient id="spectrumGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#06b6d4" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis
              dataKey="freq"
              type="number"
              domain={['auto', 'auto']}
              tickFormatter={(v) => `${Number(v).toFixed(1)}`}
              tick={{ fill: '#94a3b8', fontSize: 10 }}
              stroke="#334155"
            >
              <Label value="Frecuencia (Hz)" position="insideBottom" offset={-15} fill="#64748b" fontSize={10} />
            </XAxis>
            <YAxis
              dataKey="mag"
              tick={{ fill: '#94a3b8', fontSize: 10 }}
              stroke="#334155"
              tickFormatter={(v) => v.toExponential(1)}
              width={55}
            />
            <Tooltip content={<CustomTooltip />} />

            {/* FEM modal frequency reference lines — clickable */}
            {modalPeaks.map((peak) => {
              const isSelected = selectedMode === peak.modeId;
              return (
                <ReferenceLine
                  key={`mode-${peak.modeId}`}
                  x={peak.freqHz}
                  stroke={isSelected ? '#f59e0b' : '#7c3aed'}
                  strokeWidth={isSelected ? 2 : 1}
                  strokeDasharray={isSelected ? '0' : '4 2'}
                  label={{
                    value: `M${peak.modeId}`,
                    position: 'insideTopRight',
                    fill: isSelected ? '#f59e0b' : '#a78bfa',
                    fontSize: 9,
                    cursor: 'pointer',
                  }}
                  // Recharts ReferenceLine doesn't support onClick directly,
                  // so we render a custom dot marker via onClick on the wrapper.
                />
              );
            })}

            <Area
              type="monotone"
              dataKey="mag"
              stroke="#06b6d4"
              strokeWidth={1.5}
              fill="url(#spectrumGrad)"
              dot={false}
              activeDot={{ r: 3, fill: '#06b6d4' }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Clickable mode buttons */}
      <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
        {modalPeaks.slice(0, 15).map((peak) => {
          const isSelected = selectedMode === peak.modeId;
          return (
            <button
              key={peak.modeId}
              id={`mode-btn-${peak.modeId}`}
              onClick={() => handleModeClick(peak.modeId)}
              title={`Modo ${peak.modeId} — ${peak.freqHz.toFixed(4)} Hz\nAmplitud: ${peak.magnitude.toExponential(3)}`}
              className={`
                px-2 py-0.5 rounded text-xs font-mono border transition-all
                ${isSelected
                  ? 'bg-amber-500/20 border-amber-500/60 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.3)]'
                  : 'bg-violet-900/20 border-violet-700/40 text-violet-300 hover:bg-violet-800/30 hover:border-violet-500/60'
                }
              `}
            >
              M{peak.modeId}
              <span className="ml-1 opacity-60">{peak.freqHz.toFixed(2)}Hz</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default SpectrumChart;

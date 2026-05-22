/**
 * modalStore.ts — Zustand store for the OMA Modal Visualization Toggle
 *
 * Manages state for the two visualization modes of the 3D structural viewer:
 *
 *  Modo 1 — "Live Mirror" (viewMode = 'time'):
 *    - Consumes q_modal[] from /api/fem/modal-filtered-ws.
 *    - Deforms the GLB mesh via modal superposition:
 *        x_mesh(t) = Σ Φ_FEM,i · q_i(t)_IFFT
 *
 *  Modo 2 — "Modal Explorer" (viewMode = 'frequency'):
 *    - Pauses the real-time WebSocket.
 *    - Shows the FFT spectrum; user clicks a peak to select a mode.
 *    - Generates synthetic harmonic oscillation:
 *        x_mesh(t_sim) = A · Φ_FEM,n · sin(2π f_n t_sim)
 */
import { create } from 'zustand';
import type { ViewMode, FemModeShapeData, FftSpectrum, ModalFilteredMessage } from '../types';

// ── FEM modal frequency catalogue (matches backend _FEM_MODAL_FREQUENCIES) ────
// Used to reconstruct frequencies for modes not yet in the received spectrum.
export const FEM_MODAL_FREQUENCIES: Record<number, number> = {
  1: 0.7196,  2: 0.7197,  3: 4.224,   4: 4.224,   5: 6.527,
  6: 10.62,   7: 10.84,   8: 10.84,   9: 18.57,   10: 18.57,
  11: 18.79,  12: 18.80,  13: 19.03,  14: 19.11,  15: 19.48,
  16: 19.48,  17: 19.57,  18: 20.04,  19: 20.88,  20: 20.95,
  21: 21.51,  22: 21.79,  23: 22.91,  24: 23.49,  25: 23.51,
  26: 27.16,  27: 27.17,
};

export interface ModalStore {
  // ── View mode toggle ──────────────────────────────────────────────────────
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // ── Modal Explorer: selected mode ─────────────────────────────────────────
  /** Mode ID selected by the user clicking a spectrum peak. null = no selection. */
  selectedModeId: number | null;
  /** FEM natural frequency of the selected mode (Hz). */
  selectedModeFreq: number | null;
  selectMode: (modeId: number | null) => void;

  /** Amplitude scale factor A for the Modal Explorer synthetic oscillation.
   *  Controls visual exaggeration: x = A · Φ_FEM,n · sin(2π f_n t)
   *  Typical range: 1 – 1000 (dimensionless multiplier). */
  amplitudeScale: number;
  setAmplitudeScale: (scale: number) => void;

  // ── Live Mirror: modal coordinates q_i(t) from bandpass IFFT ─────────────
  /**
   * Map {modeId → q_i(t)} — latest band-isolated modal coordinates.
   * Sent by the backend via /api/fem/modal-filtered-ws every compute cycle.
   * Used in the superposition: x_mesh(t) = Σ Φ_FEM,i · q_i(t)
   */
  qModal: Record<string, number>;

  // ── Shared: FFT spectrum for the SpectrumChart ────────────────────────────
  fftSpectrum: FftSpectrum | null;

  /** Process an incoming WebSocket message from modal-filtered-ws. */
  processModalMessage: (msg: ModalFilteredMessage) => void;

  // ── FEM mode shapes (Φ_FEM) — loaded once from REST endpoint ─────────────
  /**
   * Mode shapes loaded from /api/fem/modal-shapes (OC4-modal_res.json).
   * Record<modeId, FemModeShapeData> where each entry contains
   * the frequency and per-node [ux, uy, uz] displacement vectors (Φ_FEM,i).
   */
  femModeShapes: Record<number, FemModeShapeData>;
  femMeshNodes: Record<string, [number, number, number]>; // node coords from modal-mesh
  femShapesLoaded: boolean;
  femShapesError: string | null;
  loadFemShapes: () => Promise<void>;
}

export const useModalStore = create<ModalStore>((set, get) => ({
  // ── Defaults ──────────────────────────────────────────────────────────────
  viewMode: 'time',
  setViewMode: (mode) => set({ viewMode: mode }),

  selectedModeId: null,
  selectedModeFreq: null,
  selectMode: (modeId) => {
    if (modeId === null) {
      set({ selectedModeId: null, selectedModeFreq: null });
      return;
    }
    const freq = FEM_MODAL_FREQUENCIES[modeId] ?? null;
    set({ selectedModeId: modeId, selectedModeFreq: freq });
  },

  amplitudeScale: 100,
  setAmplitudeScale: (scale) => set({ amplitudeScale: scale }),

  qModal: {},
  fftSpectrum: null,

  processModalMessage: (msg) => {
    // Only update q_modal and spectrum if in time mode
    // (we still update spectrum even in frequency mode for the chart)
    set({
      qModal: msg.q_modal,
      fftSpectrum: msg.fft_spectrum,
    });
  },

  // ── FEM shapes loader ─────────────────────────────────────────────────────
  femModeShapes: {},
  femMeshNodes: {},
  femShapesLoaded: false,
  femShapesError: null,

  loadFemShapes: async () => {
    if (get().femShapesLoaded) return;
    try {
      // Fetch mode shapes (autovectors Φ_FEM)
      const [shapesRes, meshRes] = await Promise.all([
        fetch('http://localhost:8080/api/fem/modal-shapes'),
        fetch('http://localhost:8080/api/fem/modal-mesh'),
      ]);

      if (!shapesRes.ok) throw new Error(`modal-shapes: HTTP ${shapesRes.status}`);
      if (!meshRes.ok)   throw new Error(`modal-mesh: HTTP ${meshRes.status}`);

      const shapesJson = await shapesRes.json();
      const meshJson   = await meshRes.json();

      // ── Parse OC4-modal_res.json ─────────────────────────────────────────
      // Format: { "modes": { "Mode_N_(Freq.:_F_Hz)": { "Modes": { "1": [ux,uy,uz,mag], ... } } } }
      const parsed: Record<number, FemModeShapeData> = {};
      const modesRaw = shapesJson?.modes ?? {};

      for (const [modeName, modeData] of Object.entries(modesRaw)) {
        // Extract mode ID from name, e.g. "Mode_1_(Freq.:_0.7196_Hz)" → 1
        const idMatch = modeName.match(/Mode_(\d+)/);
        if (!idMatch) continue;
        const modeId = parseInt(idMatch[1], 10);

        // Extract frequency from name
        const freqMatch = modeName.match(/Freq\.\:_?([\d.]+)/);
        const frequency = freqMatch
          ? parseFloat(freqMatch[1])
          : (FEM_MODAL_FREQUENCIES[modeId] ?? 0);

        const nodesRaw = (modeData as any)?.Modes ?? {};
        const nodes: Record<string, [number, number, number]> = {};
        for (const [nodeId, vals] of Object.entries(nodesRaw)) {
          const v = vals as number[];
          nodes[nodeId] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
        }

        parsed[modeId] = { frequency, nodes };
      }

      // ── Parse OC4-modal_mesh.json ────────────────────────────────────────
      // Format: { "nodes": { "1": [x, y, z], ... } }
      const meshNodes: Record<string, [number, number, number]> = {};
      const nodesRaw = meshJson?.nodes ?? {};
      for (const [nodeId, xyz] of Object.entries(nodesRaw)) {
        const v = xyz as number[];
        meshNodes[nodeId] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
      }

      set({
        femModeShapes: parsed,
        femMeshNodes: meshNodes,
        femShapesLoaded: true,
        femShapesError: null,
      });

      console.log(
        `[ModalStore] Loaded ${Object.keys(parsed).length} FEM mode shapes, ` +
        `${Object.keys(meshNodes).length} mesh nodes.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ModalStore] Failed to load FEM shapes:', msg);
      set({ femShapesError: msg, femShapesLoaded: false });
    }
  },
}));

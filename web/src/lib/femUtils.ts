/**
 * femUtils.ts — FEM modal superposition utilities
 *
 * Implements the two OMA rendering equations:
 *
 *  MODE 1 — Live Mirror (time domain):
 *    x_mesh(t) = Σ_i  Φ_FEM,i · q_i(t)_IFFT
 *
 *  MODE 2 — Modal Explorer (frequency domain):
 *    x_mesh(t_sim) = A · Φ_FEM,n · sin(2π f_n · t_sim)
 *
 * Both equations return a Float32Array of vertex displacements that can be
 * added directly to a Three.js BufferGeometry position attribute.
 */

import type { FemModeShapeData } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A mapping from node index (0-based, order matching a BufferGeometry)
 * to [ux, uy, uz] — the modal displacement for that node.
 *
 * The original JSON uses 1-based node IDs. This map uses 0-based indices
 * so it can be addressed directly into a Float32Array of vertex positions.
 */
export type NodeDisplacementMap = Float32Array; // interleaved [ux0,uy0,uz0, ux1,uy1,uz1, ...]

// ── Build a flat displacement array for one mode shape ───────────────────────

/**
 * Build a flat Float32Array [ux0,uy0,uz0, ux1,uy1,uz1, ...] from Φ_FEM,i.
 * This is pre-computed once per mode and cached for performance.
 *
 * @param modeShape - The FemModeShapeData for mode i.
 * @param nodeOrder - Ordered list of node IDs matching the GLB vertex layout.
 * @returns Float32Array of length 3 × N_nodes.
 */
export function buildModeShapeArray(
  modeShape: FemModeShapeData,
  nodeOrder: string[]
): Float32Array {
  const arr = new Float32Array(nodeOrder.length * 3);
  for (let i = 0; i < nodeOrder.length; i++) {
    const nodeId = nodeOrder[i];
    const disp = modeShape.nodes[nodeId];
    if (disp) {
      arr[i * 3]     = disp[0]; // ux
      arr[i * 3 + 1] = disp[1]; // uy
      arr[i * 3 + 2] = disp[2]; // uz
    }
    // else: node not in mode shape → zero displacement (already zero from Float32Array)
  }
  return arr;
}

// ── MODE 1: Modal Superposition (Live Mirror) ─────────────────────────────────

/**
 * Compute the deformed mesh vertex offsets using modal superposition.
 *
 * Implements the OMA time-domain reconstruction equation:
 *   x_mesh(t) = Σ_i  Φ_FEM,i · q_i(t)_IFFT
 *
 * @param modeShapeArrays - Pre-built flat arrays for each mode i (from buildModeShapeArray).
 * @param qModal          - Modal coordinates map { modeId: q_i(t) } from the backend WS.
 * @param nVertices       - Total number of vertices in the GLB mesh.
 * @returns Float32Array of length 3 × nVertices — vertex position OFFSETS (metres).
 */
export function computeModalSuperposition(
  modeShapeArrays: Record<number, Float32Array>,
  qModal: Record<string, number>,
  nVertices: number
): Float32Array {
  const offsets = new Float32Array(nVertices * 3); // zero-initialised

  for (const [modeIdStr, qi] of Object.entries(qModal)) {
    const modeId = parseInt(modeIdStr, 10);
    const phi = modeShapeArrays[modeId];
    if (!phi || qi === 0) continue;

    // x_mesh(t) += Φ_FEM,i · q_i(t)
    const len = Math.min(phi.length, offsets.length);
    for (let j = 0; j < len; j++) {
      offsets[j] += phi[j] * qi;
    }
  }

  return offsets;
}

// ── MODE 2: Synthetic Harmonic Oscillation (Modal Explorer) ──────────────────

/**
 * Compute the deformed mesh vertex offsets for a single pure mode,
 * animated as a harmonic oscillation at time t_sim.
 *
 * Implements the OMA frequency-domain synthesis equation:
 *   x_mesh(t_sim) = A · Φ_FEM,n · sin(2π · f_n · t_sim)
 *
 * @param modeShapeArray - Flat displacement array for mode n (from buildModeShapeArray).
 * @param fn             - FEM natural frequency of mode n (Hz).
 * @param tSim           - Current simulation clock time (seconds).
 * @param amplitude      - Exaggeration factor A (dimensionless; typical: 1 – 1000).
 * @returns Float32Array of length 3 × nVertices — vertex position OFFSETS.
 */
export function computeHarmonicOscillation(
  modeShapeArray: Float32Array,
  fn: number,
  tSim: number,
  amplitude: number
): Float32Array {
  // Harmonic oscillation: x = A · Φ_n · sin(2π f_n t_sim)
  const sineValue = Math.sin(2 * Math.PI * fn * tSim);
  const scale = amplitude * sineValue;

  const offsets = new Float32Array(modeShapeArray.length);
  for (let j = 0; j < modeShapeArray.length; j++) {
    offsets[j] = modeShapeArray[j] * scale;
  }
  return offsets;
}

// ── Apply offsets to a Three.js BufferGeometry position attribute ─────────────

/**
 * Apply vertex position offsets to a BufferGeometry in-place.
 *
 * Adds `offsets` to `basePositions` and writes the result to `targetArray`,
 * which is the `array` of the geometry's position BufferAttribute.
 *
 * @param basePositions - Original (rest) vertex positions (Float32Array, 3×N).
 * @param offsets       - Displacement offsets to add (Float32Array, 3×N).
 * @param targetArray   - BufferAttribute.array to write into.
 */
export function applyVerticesToGeometry(
  basePositions: Float32Array,
  offsets: Float32Array,
  targetArray: Float32Array
): void {
  const len = Math.min(basePositions.length, offsets.length, targetArray.length);
  for (let i = 0; i < len; i++) {
    targetArray[i] = basePositions[i] + offsets[i];
  }
  // If targetArray is longer (more vertices than mode shape covers), copy base as-is
  for (let i = len; i < targetArray.length; i++) {
    targetArray[i] = basePositions[i] ?? 0;
  }
}

// ── Helpers: FFT peak detection for SpectrumChart ────────────────────────────

export interface SpectrumPeak {
  modeId: number;
  freqHz: number;
  magnitude: number;
  /** Index into the freqs/magnitudes arrays. */
  binIndex: number;
}

/**
 * Find peaks in the FFT magnitude spectrum that match FEM modal frequencies.
 * Returns a list of peaks sorted by magnitude (descending) for display.
 *
 * @param freqs       - Frequency bins (Hz) from the backend.
 * @param magnitudes  - FFT magnitude at each bin.
 * @param femFreqs    - FEM modal frequency catalogue {modeId: f_i}.
 * @param bwHz        - Half-bandwidth for peak matching (Hz).
 */
export function findModalPeaks(
  freqs: number[],
  magnitudes: number[],
  femFreqs: Record<number, number>,
  bwHz = 0.5
): SpectrumPeak[] {
  const peaks: SpectrumPeak[] = [];

  for (const [modeIdStr, f_i] of Object.entries(femFreqs)) {
    const modeId = parseInt(modeIdStr, 10);
    let bestIdx = -1;
    let bestMag = -1;

    for (let i = 0; i < freqs.length; i++) {
      if (Math.abs(freqs[i] - f_i) <= bwHz && magnitudes[i] > bestMag) {
        bestMag = magnitudes[i];
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      peaks.push({
        modeId,
        freqHz: f_i,
        magnitude: bestMag,
        binIndex: bestIdx,
      });
    }
  }

  return peaks.sort((a, b) => b.magnitude - a.magnitude);
}

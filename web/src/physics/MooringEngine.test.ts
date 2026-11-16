import { describe, it, expect } from 'vitest';
import { simulateMooringClientSide } from './MooringEngine';

describe('MooringEngine', () => {
  it('computes symmetric equilibrium tensions around ~1100 kN for OC4 at zero pose', () => {
    const out = simulateMooringClientSide(
      { surge: 0, sway: 0, heave: 0, rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
      { waveHeight: 0, wavePeriod: 10, windSpeed: 0, currentSpeed: 0 }
    );
    expect(out.lines).toHaveLength(3);
    for (const ln of out.lines) {
      expect(ln.tensionFairleadKN).toBeGreaterThan(1000);
      expect(ln.tensionFairleadKN).toBeLessThan(1250);
      expect(ln.laidLengthM).toBeGreaterThan(200);
      expect(ln.nodes3d).toHaveLength(21);
      expect(ln.segmentTensionsKN).toHaveLength(20);
    }
  });

  it('increases Line 1 tension and reduces laid length under positive surge', () => {
    const out = simulateMooringClientSide(
      { surge: 10, sway: 0, heave: 0, rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
      { waveHeight: 1.5, wavePeriod: 10, windSpeed: 8, currentSpeed: 0.5 }
    );
    expect(out.lines[0].tensionFairleadKN).toBeGreaterThan(out.lines[2].tensionFairleadKN);
    expect(out.lines[0].laidLengthM).toBeLessThan(100);
  });

  it('handles LINE_BREAKAGE fault injection cleanly', () => {
    const out = simulateMooringClientSide(
      { surge: 0, sway: 0, heave: 0, rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
      { waveHeight: 1.5, wavePeriod: 10, windSpeed: 8, currentSpeed: 0.5 },
      { lineIdx: 1, shmClass: 'LINE_BREAKAGE' }
    );
    expect(out.lines[1].shmStatus).toBe('LINE_BREAKAGE');
    expect(out.lines[1].tensionFairleadKN).toBe(0);
  });
});

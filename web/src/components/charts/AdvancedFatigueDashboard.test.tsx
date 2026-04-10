import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdvancedFatigueDashboard from './AdvancedFatigueDashboard';
import type { FatigueDashboardConfig } from './AdvancedFatigueDashboard';

const makeHistory = (count: number, fatigueStart = 1) => {
  const now = Date.now();
  return Array.from({ length: count }).map((_, index) => ({
    timestamp: now + index * 1000,
    mooringTension: 3000 + index * 10,
    towerStress: 80 + index * 0.5,
    fatigueLife: fatigueStart + index * 0.1
  }));
};

const testConfig: FatigueDashboardConfig = {
  refreshRateMs: 0,
  maxPoints: 40,
  thresholds: {
    warning: 60,
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
    epsilon: 0.000001
  },
  heatmap: {
    columns: 8,
    legendTicks: 5
  },
  fit: {
    paddingPercent: 0.06,
    minimumPadding: 0.01
  }
};

describe('AdvancedFatigueDashboard', () => {
  const resizeObservers: Array<{ trigger: () => void }> = [];
  let rafHandle = 0;
  const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) => {
        rafHandle += 1;
        const id = rafHandle;
        const timer = setTimeout(() => callback(performance.now()), 1);
        rafTimers.set(id, timer);
        return id;
      }
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const timer = rafTimers.get(id);
      if (timer) clearTimeout(timer);
      rafTimers.delete(id);
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe = () => {
          this.callback(
            [{ contentRect: { width: 640, height: 320 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          );
          resizeObservers.push({ trigger: () => this.callback([{ contentRect: { width: 800, height: 420 } } as ResizeObserverEntry], this as unknown as ResizeObserver) });
        };
        unobserve = () => {};
        disconnect = () => {};
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resizeObservers.length = 0;
    rafTimers.forEach((timer) => clearTimeout(timer));
    rafTimers.clear();
  });

  it('renderiza el dashboard y el heatmap con leyenda dinámica', () => {
    render(<AdvancedFatigueDashboard history={makeHistory(30)} config={testConfig} />);
    expect(screen.getByText('Advanced Fatigue Analysis (ASTM E466 / Eurocode 3)')).toBeInTheDocument();
    expect(screen.getByText('Damage Heatmap')).toBeInTheDocument();
    expect(screen.getByText('Scale: linear')).toBeInTheDocument();
    expect(screen.getByText(/Color = daño acumulado relativo/i)).toBeInTheDocument();
  });

  it('actualiza datos tras recibir nuevo history sin recargar vista', async () => {
    const { rerender } = render(<AdvancedFatigueDashboard history={makeHistory(20, 1)} config={testConfig} />);
    rerender(<AdvancedFatigueDashboard history={makeHistory(20, 10)} config={testConfig} />);
    expect(await screen.findByText(/Tower Base · Z=0m/i)).toBeInTheDocument();
    expect(screen.getAllByText(/%/).length).toBeGreaterThan(0);
  });

  it('recalcula tras resize y mantiene la vista activa', async () => {
    render(<AdvancedFatigueDashboard history={makeHistory(25)} config={testConfig} />);
    resizeObservers.forEach((observer) => observer.trigger());
    await waitFor(() => {
      expect(screen.getByText('S-N Curve (Wöhler)')).toBeInTheDocument();
      expect(screen.getByText('Daily Max Stress vs Cycles')).toBeInTheDocument();
    });
  });

  it('muestra tooltip dinámico del heatmap al hacer hover', async () => {
    render(<AdvancedFatigueDashboard history={makeHistory(30)} config={testConfig} />);
    const cells = await screen.findAllByLabelText(/cycle/i);
    fireEvent.mouseEnter(cells[0]);
    await waitFor(() => {
      const tooltip = screen.getByText((content) => content.includes('Cycle') && content.includes('Damage'));
      expect(tooltip).toBeInTheDocument();
      expect(screen.queryByText(/Hover over a cell/i)).not.toBeInTheDocument();
    });
  });

  it('permite destruir el componente limpiamente', () => {
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const { unmount } = render(<AdvancedFatigueDashboard history={makeHistory(10)} config={testConfig} />);
    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});

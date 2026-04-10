import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import InteractiveMap from './InteractiveMap';

// Mock Leaflet
vi.mock('leaflet', () => ({
  default: {
    icon: vi.fn(),
    Marker: {
      prototype: {
        options: {}
      }
    }
  }
}));

// Mock react-leaflet
const mockFlyTo = vi.fn();
const mockPanTo = vi.fn();
const mockGetZoom = vi.fn(() => 13);
const mockStop = vi.fn();

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div>{children}</div>,
  TileLayer: () => <div>TileLayer</div>,
  Marker: ({ children }: any) => <div>{children}</div>,
  Popup: ({ children }: any) => <div>{children}</div>,
  useMap: () => ({
    flyTo: mockFlyTo,
    panTo: mockPanTo,
    getZoom: mockGetZoom,
    stop: mockStop
  }),
  useMapEvents: ({ dragstart, dragend, zoomstart, zoomend }: any) => {
    // Expose handlers to test
    (globalThis as any).mockMapEvents = { dragstart, dragend, zoomstart, zoomend };
    return null;
  }
}));

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Search: () => <div>SearchIcon</div>,
  Locate: () => <div>LocateIcon</div>
}));

describe('InteractiveMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).mockMapEvents = {};
  });

  it('should render correctly', () => {
    render(<InteractiveMap />);
    // Basic render check
  });

  it('should flyTo new center when distance is large', () => {
    const { rerender } = render(<InteractiveMap center={[0, 0]} />);
    
    // Initial render might trigger effect
    mockFlyTo.mockClear();

    // Update center significantly
    rerender(<InteractiveMap center={[10, 10]} />);
    
    expect(mockFlyTo).toHaveBeenCalled();
  });

  it('should panTo new center when distance is small', () => {
    const { rerender } = render(<InteractiveMap center={[0, 0]} />);
    mockFlyTo.mockClear();
    mockPanTo.mockClear();

    // Update center slightly (e.g. tracking)
    // 0.0001 degrees is small
    rerender(<InteractiveMap center={[0.0001, 0.0001]} />);
    
    expect(mockPanTo).toHaveBeenCalled();
    expect(mockFlyTo).not.toHaveBeenCalled();
  });

  it('should NOT update view when user is interacting', () => {
    vi.useFakeTimers();
    const { rerender } = render(<InteractiveMap center={[0, 0]} />);
    mockFlyTo.mockClear();
    mockPanTo.mockClear();

    // Simulate user drag start
    act(() => {
      if ((globalThis as any).mockMapEvents.dragstart) {
        (globalThis as any).mockMapEvents.dragstart();
      }
    });

    // Update center
    rerender(<InteractiveMap center={[10, 10]} />);
    
    expect(mockFlyTo).not.toHaveBeenCalled();
    expect(mockPanTo).not.toHaveBeenCalled();

    // Simulate drag end
    act(() => {
        if ((globalThis as any).mockMapEvents.dragend) {
          (globalThis as any).mockMapEvents.dragend();
        }
    });

    // Wait for timeout (mock timers)
    act(() => {
        vi.advanceTimersByTime(1100);
    });

    // Update center again
    rerender(<InteractiveMap center={[20, 20]} />);
    expect(mockFlyTo).toHaveBeenCalled();
    
    vi.useRealTimers();
  });
});

# OC4 Digital Twin Dashboard

React-based dashboard for visualizing the OC4 Digital Twin data.

## Features
- **3D Visualization**: Interactive 3D model of the platform using React Three Fiber.
- **Live Video Feed**: Displays video stream with overlay of detected keypoints.
- **Real-time Charts**: Live graphs of navigation angles (roll, pitch, yaw).
- **Grafana Integration**: Embedded Grafana dashboards.

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

## Running the Development Server

```bash
npm run dev
```

The application will be available at `http://localhost:5173`.

## Environment
Ensure the backend is running on `http://localhost:8000`.

## Advanced Fatigue Analysis Technical Notes

The Advanced Fatigue Analysis module now includes:

- Real-time rendering throttled with `requestAnimationFrame` and configurable `refreshRateMs`.
- Automatic WebSocket reconnection on SHM stream interruptions.
- Fit-to-view dynamic domains for SCF and Stress-vs-Cycles charts with configurable padding.
- Responsive chart reflow using `ResizeObserver` and forced chart-key invalidation on container/window resize.
- Damage Heatmap with:
  - Value sanitization for missing/invalid points before rendering.
  - Normalized range `0..1` with optional logarithmic scaling for high dynamic-range inputs.
  - Continuous color interpolation.
  - DPI-aware cell sizing and dynamic legend.
  - Hover details with coordinate, accumulated damage, and cycle index.

Configuration file:

- `public/advanced-fatigue.config.json`

Main implementation files:

- `src/components/charts/AdvancedFatigueDashboard.tsx`
- `src/pages/SHMPage.tsx`

## Release Notes (Maintenance Team)

- Added runtime-configurable fatigue dashboard parameters via JSON.
- Reduced render pressure by gating SHM updates and history propagation with RAF cadence.
- Added WebSocket auto-reconnect logic for SHM stream stability.
- Added fit-to-view behavior and responsive recalculation for chart domains/sizing.
- Reworked Damage Heatmap rendering and interaction model.
- Added automated tests for initial render, live update behavior, and clean unmount:
  - `src/components/charts/AdvancedFatigueDashboard.test.tsx`

/**
 * Structure3DViewer.tsx
 *
 * Structural visualization panel. Renders the FemMeshViewer which includes:
 *  - The OC4 GLB model with real-time vertex morphing via OMA modal superposition
 *  - A mode toggle: "Live Mirror" (time domain) ↔ "Modal Explorer" (frequency domain)
 *  - An FFT spectrum chart for interactive mode selection (Modal Explorer mode)
 */
import { FemMeshViewer } from './FemMeshViewer';

export default function Structure3DViewer() {
  return (
    <div className="w-full h-full">
      <FemMeshViewer />
    </div>
  );
}

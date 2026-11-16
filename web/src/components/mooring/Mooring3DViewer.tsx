import { useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Line, PerspectiveCamera, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { Compass, Layers, Box } from 'lucide-react';
import type { MooringAnalysisOutput, MooringPoseInput } from '../../physics/MooringEngine';

interface Mooring3DViewerProps {
  analysis: MooringAnalysisOutput;
  pose: MooringPoseInput;
  colorMode: 'tension' | 'touchdown';
}

// Convert prototype meters [x, y, z] (Z-up) -> Three.js scene units (Y-up, scaled 1:100)
const SCENE_SCALE = 0.01;
function toThree(p: [number, number, number]): [number, number, number] {
  return [p[0] * SCENE_SCALE, p[2] * SCENE_SCALE, -p[1] * SCENE_SCALE];
}

function tensionToColor(tensionKN: number, isBroken: boolean): string {
  if (isBroken) return '#ef4444';
  // Nominal ~1100 kN, high tension ~2500+ kN (MBL = 10,000 kN)
  const ratio = Math.max(0, Math.min(1, (tensionKN - 700) / 2200));
  if (ratio < 0.45) {
    // Cyan -> Emerald
    return ratio < 0.2 ? '#06b6d4' : '#10b981';
  }
  if (ratio < 0.75) {
    return '#f59e0b';
  }
  return '#ef4444';
}

function PlatformMesh({ pose }: { pose: MooringPoseInput }) {
  const pos = toThree([pose.surge, pose.sway, pose.heave]);
  const euler = useMemo(
    () =>
      new THREE.Euler(
        (pose.rollDeg * Math.PI) / 180,
        (pose.yawDeg * Math.PI) / 180,
        -(pose.pitchDeg * Math.PI) / 180,
        'YXZ'
      ),
    [pose.rollDeg, pose.pitchDeg, pose.yawDeg]
  );

  // OC4 columns at R = 28.87 m (~0.29 units), fairlead radius 40.87 m (~0.41 units)
  const colPositions: [number, number, number][] = [180, 60, 300].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return [0.29 * Math.cos(rad), -0.05, -0.29 * Math.sin(rad)];
  });

  return (
    <group position={pos} rotation={euler}>
      {/* Central column */}
      <mesh position={[0, -0.04, 0]}>
        <cylinderGeometry args={[0.045, 0.045, 0.32, 20]} />
        <meshStandardMaterial color="#f59e0b" metalness={0.35} roughness={0.45} />
      </mesh>

      {/* 3 Outer columns */}
      {colPositions.map((cPos, idx) => (
        <mesh key={idx} position={cPos}>
          <cylinderGeometry args={[0.06, 0.06, 0.32, 20]} />
          <meshStandardMaterial color="#fbbf24" metalness={0.35} roughness={0.45} />
        </mesh>
      ))}

      {/* Upper deck struts */}
      {[180, 60, 300].map((deg, idx) => {
        const rad = (deg * Math.PI) / 180;
        const x = 0.145 * Math.cos(rad);
        const z = -0.145 * Math.sin(rad);
        return (
          <mesh key={`strut-${idx}`} position={[x, 0.08, z]} rotation={[0, rad, Math.PI / 2]}>
            <cylinderGeometry args={[0.015, 0.015, 0.29, 12]} />
            <meshStandardMaterial color="#94a3b8" metalness={0.4} roughness={0.5} />
          </mesh>
        );
      })}

      {/* Tower */}
      <mesh position={[0, 0.52, 0]}>
        <cylinderGeometry args={[0.02, 0.032, 0.85, 16]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.25} roughness={0.4} />
      </mesh>

      {/* Nacelle + Rotor Hub */}
      <mesh position={[0.02, 0.96, 0]}>
        <boxGeometry args={[0.14, 0.05, 0.05]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.3} roughness={0.4} />
      </mesh>
      <mesh position={[-0.07, 0.96, 0]} rotation={[0, 0, Math.PI / 2]}>
        <coneGeometry args={[0.025, 0.06, 12]} />
        <meshStandardMaterial color="#3b82f6" metalness={0.3} roughness={0.4} />
      </mesh>
    </group>
  );
}

export default function Mooring3DViewer({ analysis, pose, colorMode }: Mooring3DViewerProps) {
  const controlsRef = useRef<any>(null);

  const setView = (view: 'iso' | 'top' | 'side') => {
    const ctrl = controlsRef.current;
    if (!ctrl) return;
    if (view === 'iso') {
      ctrl.object.position.set(8.5, 4.8, 8.5);
      ctrl.target.set(0, -0.8, 0);
    } else if (view === 'top') {
      ctrl.object.position.set(0, 14.5, 0.01);
      ctrl.target.set(0, -1.0, 0);
    } else {
      ctrl.object.position.set(0, -0.6, 12.5);
      ctrl.target.set(0, -1.0, 0);
    }
    ctrl.update();
  };

  return (
    <div className="relative w-full h-[460px] rounded-2xl overflow-hidden border border-gray-200 dark:border-slate-700 bg-slate-950">
      {/* Camera quick presets */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 bg-slate-900/80 backdrop-blur border border-slate-700/80 rounded-lg p-1">
        <button
          onClick={() => setView('iso')}
          className="px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 rounded flex items-center gap-1"
        >
          <Box className="w-3.5 h-3.5 text-blue-400" /> Iso
        </button>
        <button
          onClick={() => setView('top')}
          className="px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 rounded flex items-center gap-1"
        >
          <Compass className="w-3.5 h-3.5 text-cyan-400" /> Planta
        </button>
        <button
          onClick={() => setView('side')}
          className="px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 rounded flex items-center gap-1"
        >
          <Layers className="w-3.5 h-3.5 text-emerald-400" /> Perfil
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-10 bg-slate-900/85 backdrop-blur border border-slate-700/80 rounded-lg px-3 py-2 text-[11px] text-slate-300 space-y-1">
        <div className="font-semibold text-slate-100">
          {colorMode === 'tension' ? 'Tensión Axial Segmento' : 'Contacto Lecho Marino (TDZ)'}
        </div>
        {colorMode === 'tension' ? (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-cyan-500" /> &lt; 1.1 MN</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> 1.1–1.7 MN</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> 1.7–2.3 MN</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500" /> &gt; 2.3 MN / Fallo</span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-400" /> Apoyado en lecho (z = -200m)</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-sky-400" /> Tramo suspendido</span>
          </div>
        )}
      </div>

      <div className="absolute top-3 right-3 z-10 bg-slate-900/80 backdrop-blur border border-slate-700/80 rounded-lg px-2.5 py-1 text-[11px] font-mono text-slate-300">
        Escala escena 1:100 · Profundidad 200m · Radio anclas 837.6m
      </div>

      <Canvas shadows>
        <PerspectiveCamera makeDefault position={[8.5, 4.8, 8.5]} fov={45} near={0.1} far={200} />
        <OrbitControls ref={controlsRef} target={[0, -0.8, 0]} enableDamping dampingFactor={0.08} />

        <ambientLight intensity={0.65} />
        <directionalLight position={[10, 14, 8]} intensity={1.1} />
        <pointLight position={[-8, 6, -8]} intensity={0.4} color="#60a5fa" />

        {/* Water Surface SWL (z = 0) */}
        <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[9.5, 64]} />
          <meshStandardMaterial color="#0284c7" transparent opacity={0.16} side={THREE.DoubleSide} />
        </mesh>

        {/* Seabed plane (z = -200 m -> y = -2.0) */}
        <mesh position={[0, -2.0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[9.5, 64]} />
          <meshStandardMaterial color="#1e293b" transparent opacity={0.85} side={THREE.DoubleSide} />
        </mesh>
        <Grid
          position={[0, -1.995, 0]}
          args={[18, 18]}
          cellSize={1}
          cellThickness={0.4}
          cellColor="#334155"
          sectionSize={5}
          sectionThickness={0.8}
          sectionColor="#475569"
          fadeDistance={28}
        />

        {/* OC4 Platform */}
        <PlatformMesh pose={pose} />

        {/* 3 Mooring Lines */}
        {analysis.lines.map((line) => {
          const pts3d = line.nodes3d.map(toThree);
          const isBroken = line.shmStatus === 'LINE_BREAKAGE';
          const segmentColors = line.segmentTensionsKN.map((tKN, sIdx) => {
            if (colorMode === 'touchdown') {
              const td = (line.touchdownProbs[sIdx] + line.touchdownProbs[sIdx + 1]) * 0.5;
              return td >= 0.5 ? '#f59e0b' : '#38bdf8';
            }
            return tensionToColor(tKN, isBroken);
          });

          const anchorPt = pts3d[0];
          const tdpPt = pts3d[Math.min(line.touchdownNodeIdx, pts3d.length - 1)];

          return (
            <group key={line.id}>
              {/* Segments */}
              {pts3d.slice(0, -1).map((pStart, sIdx) => (
                <Line
                  key={`seg-${line.id}-${sIdx}`}
                  points={[pStart, pts3d[sIdx + 1]]}
                  color={segmentColors[sIdx]}
                  lineWidth={3}
                />
              ))}

              {/* Node dots */}
              {pts3d.map((pt, nIdx) => {
                const isTd = line.touchdownProbs[nIdx] >= 0.5;
                const dotColor =
                  nIdx === 0
                    ? '#94a3b8'
                    : nIdx === pts3d.length - 1
                      ? '#ffffff'
                      : isTd
                        ? '#f59e0b'
                        : '#38bdf8';
                return (
                  <mesh key={`node-${line.id}-${nIdx}`} position={pt}>
                    <sphereGeometry args={[nIdx === 0 || nIdx === pts3d.length - 1 ? 0.075 : 0.04, 10, 10]} />
                    <meshStandardMaterial color={dotColor} />
                  </mesh>
                );
              })}

              {/* Anchor block */}
              <mesh position={anchorPt}>
                <boxGeometry args={[0.18, 0.08, 0.18]} />
                <meshStandardMaterial color="#64748b" />
              </mesh>

              {/* Touchdown Point (TDP) marker ring */}
              {line.laidLengthM > 1 && (
                <mesh position={[tdpPt[0], -1.98, tdpPt[2]]} rotation={[-Math.PI / 2, 0, 0]}>
                  <ringGeometry args={[0.09, 0.14, 24]} />
                  <meshBasicMaterial color="#fbbf24" side={THREE.DoubleSide} />
                </mesh>
              )}
            </group>
          );
        })}
      </Canvas>
    </div>
  );
}

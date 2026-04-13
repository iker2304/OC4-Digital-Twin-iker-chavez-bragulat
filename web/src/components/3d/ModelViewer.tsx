import { Suspense, useState, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, Environment, useGLTF, PerspectiveCamera, CameraControls, ContactShadows, Stars } from '@react-three/drei';
import { useTwinStore } from '../../store/twinStore';
import * as THREE from 'three';
import { Box, Eye, LayoutGrid, Monitor, Video } from 'lucide-react';

// Camera View Types
type CameraView = 'live' | 'top' | 'side' | 'front' | 'iso';

interface ViewConfig {
  position: [number, number, number];
  target: [number, number, number];
  label: string;
  icon: any;
}

const VIEW_CONFIGS: Record<CameraView, ViewConfig> = {
  live: { 
    position: [3, 3, 3], 
    target: [0, 0, 0], 
    label: 'Live Tracking',
    icon: Video
  },
  top: { 
    position: [0, 7.5, 0], // Y-axis is vertical (Up)
    target: [0, 0, 0], 
    label: 'Top View',
    icon: LayoutGrid
  },
  side: { 
    position: [7.5, 0, 0], // X-axis is Right/Left
    target: [0, 0, 0], 
    label: 'Side View',
    icon: Monitor
  },
  front: { 
    position: [0, 0, 7.5], // Z-axis is Front/Back
    target: [0, 0, 0], 
    label: 'Front View',
    icon: Eye
  },
  iso: { 
    position: [7.5, 7.5, 7.5], 
    target: [0, 0, 0], 
    label: 'Isometric',
    icon: Box
  }
};

// Optimized camera controller using a single matrix for transformations
const LiveCameraController = ({ active }: { active: boolean }) => {
  const { camera } = useThree();
  const { pose } = useTwinStore();

  // Create reusable objects outside useFrame to avoid GC pauses
  const axis = useRef(new THREE.Vector3());
  const qObjToCamCv = useRef(new THREE.Quaternion());
  const camQuatThree = useRef(new THREE.Quaternion());
  const objToCamCv4 = useRef(new THREE.Matrix4());
  const objToCamCv3 = useRef(new THREE.Matrix3());
  const camToObjCv3 = useRef(new THREE.Matrix3());
  const camToObjThree3 = useRef(new THREE.Matrix3());
  const camToObjThree4 = useRef(new THREE.Matrix4());
  const camPosCv = useRef(new THREE.Vector3());
  const camPosThree = useRef(new THREE.Vector3());
  const tvec = useRef(new THREE.Vector3());
  const cvToThree = useRef(new THREE.Matrix3().set(
    1, 0, 0,
    0, -1, 0,
    0, 0, -1
  ));

  useFrame(() => {
    if (!active) return;
    if (!pose || !pose.rvec || !pose.tvec) return;
    
    // Check if pose is valid (not all zeros)
    if (pose.rvec[0] === 0 && pose.rvec[1] === 0 && pose.rvec[2] === 0 && 
        pose.tvec[0] === 0 && pose.tvec[1] === 0 && pose.tvec[2] === 0) return;

    if (pose.rvec.length < 3 || pose.tvec.length < 3) return;

    const rx = pose.rvec[0];
    const ry = pose.rvec[1];
    const rz = pose.rvec[2];
    
    const tx = pose.tvec[0];
    const ty = pose.tvec[1];
    const tz = pose.tvec[2];

    if (isNaN(rx) || isNaN(ry) || isNaN(rz) || isNaN(tx) || isNaN(ty) || isNaN(tz)) return;

    const theta = Math.sqrt(rx*rx + ry*ry + rz*rz);
    
    axis.current.set(
      theta > 0 ? rx / theta : 1,
      theta > 0 ? ry / theta : 0,
      theta > 0 ? rz / theta : 0
    );
    
    // OpenCV extrinsics: X_cam = R * X_obj + t
    qObjToCamCv.current.setFromAxisAngle(axis.current, theta);
    objToCamCv4.current.makeRotationFromQuaternion(qObjToCamCv.current);
    objToCamCv3.current.setFromMatrix4(objToCamCv4.current);

    // Camera pose in object frame (OpenCV): C = -R^T * t
    camToObjCv3.current.copy(objToCamCv3.current).transpose();
    tvec.current.set(tx, ty, tz);
    camPosCv.current.copy(tvec.current).applyMatrix3(camToObjCv3.current).multiplyScalar(-1);

    // Convert OpenCV coordinates (x, y down, z forward) to Three.js (x, y up, z backward).
    camPosThree.current.copy(camPosCv.current).applyMatrix3(cvToThree.current);
    camera.position.copy(camPosThree.current);

    // Convert camera rotation: R_three = S * R_cv * S, where S = diag(1, -1, -1).
    camToObjThree3.current
      .copy(cvToThree.current)
      .multiply(camToObjCv3.current)
      .multiply(cvToThree.current);

    const e = camToObjThree3.current.elements;
    const n11 = e[0], n12 = e[3], n13 = e[6];
    const n21 = e[1], n22 = e[4], n23 = e[7];
    const n31 = e[2], n32 = e[5], n33 = e[8];
    camToObjThree4.current.set(
      n11, n12, n13, 0,
      n21, n22, n23, 0,
      n31, n32, n33, 0,
      0, 0, 0, 1
    );
    camQuatThree.current.setFromRotationMatrix(camToObjThree4.current);
    camera.quaternion.copy(camQuatThree.current);
    camera.updateMatrixWorld();
  });

  return null;
};

// Component to handle static camera transitions
const StaticCameraController = ({ view, active }: { view: CameraView, active: boolean }) => {
  const controlsRef = useRef<CameraControls>(null);
  // Track which view was last applied so we only call setLookAt when view actually changes.
  // Using useRef (not state) because we don't want a re-render, just a flag for useFrame.
  const appliedView = useRef<CameraView | null>(null);

  useFrame(() => {
    if (!active || !controlsRef.current) return;
    // CameraControls is guaranteed to be initialised by the time useFrame runs,
    // so this is more reliable than useEffect for Three.js objects.
    if (appliedView.current !== view) {
      const config = VIEW_CONFIGS[view];
      controlsRef.current.setLookAt(
        config.position[0], config.position[1], config.position[2],
        config.target[0], config.target[1], config.target[2],
        true // smooth animated transition
      );
      appliedView.current = view;
    }
  });

  return <CameraControls ref={controlsRef} enabled={active} />;
};

const GLBModel = ({ url, onModelLoaded }: { url: string; onModelLoaded?: (scene: THREE.Group) => void }) => {
  const { scene, animations } = useGLTF(url);
  // Enable shadows
  useEffect(() => {
    if (scene) {
      scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      if (animations && animations.length > 0) {
        console.log('Model has animations:', animations.map(a => a.name));
      }
      if (onModelLoaded) onModelLoaded(scene);
    }
  }, [scene, onModelLoaded, animations]);

  return <primitive object={scene} scale={1} />; 
};


const LivePlatformController = ({
  targetRef,
  active
}: {
  targetRef: React.RefObject<THREE.Group | null>;
  active: boolean;
}) => {
  const axis = useRef(new THREE.Vector3());
  const qCv = useRef(new THREE.Quaternion());
  const qTarget = useRef(new THREE.Quaternion());
  const eulerTarget = useRef(new THREE.Euler());
  
  // Ref for previous valid pose to prevent abrupt jumps
  const prevValidTarget = useRef<{ position: THREE.Vector3, quaternion: THREE.Quaternion } | null>(null);

  useFrame((_state, delta) => {
    if (!active) return;
    const group = targetRef.current;
    if (!group) return;

    const { pose, navigation } = useTwinStore.getState();
    const hasPose = !!pose && !!pose.rvec && !!pose.tvec && 
      pose.rvec.length >= 3 && pose.tvec.length >= 3 &&
      !(pose.rvec[0] === 0 && pose.rvec[1] === 0 && pose.rvec[2] === 0 && 
        pose.tvec[0] === 0 && pose.tvec[1] === 0 && pose.tvec[2] === 0) &&
      !isNaN(pose.rvec[0]) && !isNaN(pose.rvec[1]) && !isNaN(pose.rvec[2]) &&
      !isNaN(pose.tvec[0]) && !isNaN(pose.tvec[1]) && !isNaN(pose.tvec[2]);

    // Create temporary objects to hold the new target
    const newTargetPosition = new THREE.Vector3();
    const newTargetQuaternion = new THREE.Quaternion();

    if (hasPose) {
      const rx = pose.rvec[0];
      const ry = pose.rvec[1];
      const rz = pose.rvec[2];
      const tx = pose.tvec[0];
      const ty = pose.tvec[1];
      const tz = pose.tvec[2];
      const theta = Math.sqrt(rx * rx + ry * ry + rz * rz);
      axis.current.set(theta > 1e-8 ? rx / theta : 1, theta > 1e-8 ? ry / theta : 0, theta > 1e-8 ? rz / theta : 0);
      qCv.current.setFromAxisAngle(axis.current, theta);

      newTargetPosition.set(tx, -ty, -tz);
      newTargetQuaternion.copy(qCv.current);
    } else {
      const nx = Number(navigation?.position?.x) || 0;
      const ny = Number(navigation?.position?.y) || 0;
      const nz = Number(navigation?.position?.z) || 0;
      newTargetPosition.set(nx, nz, -ny);

      const npitch = Number(navigation?.pitch) || 0;
      const nyaw = Number(navigation?.yaw) || 0;
      const nroll = Number(navigation?.roll) || 0;

      eulerTarget.current.set(
        THREE.MathUtils.degToRad(nroll),
        THREE.MathUtils.degToRad(-nyaw),
        THREE.MathUtils.degToRad(npitch)
      );
      newTargetQuaternion.setFromEuler(eulerTarget.current);
    }

    // Filter out abrupt movements (high angular/positional velocity)
    let isOutlier = false;
    if (prevValidTarget.current && hasPose) {
      // Calculate angular distance between previous and new quaternion
      const angleDiff = prevValidTarget.current.quaternion.angleTo(newTargetQuaternion);
      // Calculate position distance
      const posDiff = prevValidTarget.current.position.distanceTo(newTargetPosition);

      // Thresholds for abrupt changes (e.g. angle > 0.5 rad (~28 deg) or distance > 5 units per frame)
      if (angleDiff > 0.5 || posDiff > 5.0) {
        isOutlier = true;
      }
    }

    if (!isOutlier) {
      // Accept new target
      qTarget.current.copy(newTargetQuaternion);
      
      // Update previous valid state
      if (!prevValidTarget.current) {
        prevValidTarget.current = {
          position: newTargetPosition.clone(),
          quaternion: newTargetQuaternion.clone()
        };
        group.position.copy(newTargetPosition);
      } else {
        prevValidTarget.current.position.copy(newTargetPosition);
        prevValidTarget.current.quaternion.copy(newTargetQuaternion);
      }
    } else if (prevValidTarget.current) {
      qTarget.current.copy(prevValidTarget.current.quaternion);
    }

    // Smoothly interpolate position and rotation
    const alpha = Math.min(1, delta * 6);
    if (prevValidTarget.current) {
      group.position.lerp(prevValidTarget.current.position, alpha);
    }
    group.quaternion.slerp(qTarget.current, alpha);
  });

  return null;
};

// Angular offsets for each blade colour within the rotor (120° apart).
// Standard orientation: reference blade points "up" (90° / PI/2) when rotation is 0.
// We use positive (CCW) offsets to match the model's blade order.
const ROTOR_BLADE_OFFSETS: Record<string, number> = {
  'blade_blue':   (Math.PI / 2),
  'blade_yellow': (Math.PI / 2) + (2 * Math.PI) / 3,
  'blade_red':    (Math.PI / 2) + (4 * Math.PI) / 3,
};

// Lerp two angles taking the shortest arc (avoids wrap-around jumps at ±π)
function lerpAngleShortest(current: number, target: number, alpha: number): number {
  let diff = target - current;
  while (diff >  Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return current + diff * alpha;
}

const BladeController = ({ scene }: { scene: THREE.Group | null }) => {
  const rotationNode = useRef<THREE.Object3D | null>(null);
  const lastLoggedRef = useRef<number>(0);
  // Two-stage smoothing: first filter the raw detected angle, then follow with the model
  const smoothedAngleRef = useRef<number | null>(null);

  useEffect(() => {
    if (!scene) return;

    const targetNames = [
      'rotate', 'rotation', 'Hub', 'VIS_Hub', 'VIS_Hub_rotation', 'rotor', 'Rotor',
      'Shaft', 'shaft', 'blade_parent', 'Armature', 'RootNode'
    ];

    let foundNode: THREE.Object3D | null = null;

    // Exact name search (case-sensitive first, then case-insensitive)
    for (const name of targetNames) {
      const node = scene.getObjectByName(name);
      if (node) {
        foundNode = node;
        break;
      }
    }

    // Fuzzy search fallback
    if (!foundNode) {
      scene.traverse((child) => {
        if (foundNode) return;
        const lowerName = child.name.toLowerCase();
        if (
          lowerName === 'rotate' ||
          lowerName === 'rotation' ||
          lowerName === 'hub' ||
          lowerName === 'rotor' ||
          lowerName === 'shaft' ||
          lowerName.includes('rotor') ||
          lowerName.includes('hub_rot') ||
          lowerName.includes('blade_root')
        ) {
          foundNode = child;
        }
      });
    }

    // If we found a "Hub" node but it's just a point (no children),
    // we probably want its parent which likely contains the actual blade meshes.
    if (foundNode && foundNode.name.toLowerCase().includes('hub') && foundNode.children.length === 0) {
      if (foundNode.parent) {
        console.log(`BladeController: Found ${foundNode.name} with no children, switching to parent ${foundNode.parent.name}`);
        foundNode = foundNode.parent;
      }
    }

    if (foundNode) {
      console.log('BladeController: Target rotation node found:', foundNode.name);
      rotationNode.current = foundNode;
      
      // Check for children with color names to confirm offsets
      const childrenNames = foundNode.children.map(c => c.name.toLowerCase());
      console.log('BladeController: Rotor children:', childrenNames);
    } else {
      console.warn('BladeController: No rotation/hub node found in model hierarchy.');
      console.log('BladeController: Top level nodes:', scene.children.map(c => c.name));
    }
  }, [scene]);

  useFrame((_state, delta) => {
    const now = Date.now();
    const shouldLog = now - lastLoggedRef.current > 5000;

    if (!rotationNode.current) {
      if (shouldLog) {
        console.log('BladeController: Waiting for rotation node...');
        lastLoggedRef.current = now;
      }
      return;
    }

    const { video } = useTwinStore.getState();

    if (!video.keypoints || video.keypoints.length === 0) {
      if (shouldLog) {
        console.log('BladeController: No keypoints available');
        lastLoggedRef.current = now;
      }
      return;
    }

    // Find the Hub keypoint to use as the center of rotation
    const hubKpt = video.keypoints.find(k => String(k.id).toLowerCase() === 'hub');
    
    let hubX: number;
    let hubY: number;

    if (hubKpt) {
      hubX = hubKpt.x;
      hubY = hubKpt.y;
      if (shouldLog) {
        console.log(`BladeController: Using dedicated Hub keypoint at (${hubX.toFixed(1)}, ${hubY.toFixed(1)})`);
      }
    } else {
      // Fallback: Hub center = centroid of all Rotor keypoints
      const rotorKpts = video.keypoints.filter(k => {
        const id = String(k.id).toLowerCase();
        return id.startsWith('blade_red') || id.startsWith('blade_blue') || id.startsWith('blade_yellow');
      });

      if (rotorKpts.length === 0) {
        if (shouldLog) {
          console.log('BladeController: No Hub or Rotor keypoints found');
          lastLoggedRef.current = now;
        }
        return;
      }

      hubX = rotorKpts.reduce((sum, k) => sum + k.x, 0) / rotorKpts.length;
      hubY = rotorKpts.reduce((sum, k) => sum + k.y, 0) / rotorKpts.length;
      
      if (shouldLog) {
        console.log(`BladeController: Falling back to Rotor centroid at (${hubX.toFixed(1)}, ${hubY.toFixed(1)})`);
      }
    }

    // Collect all Rotor keypoints for tip detection
    const rotorKpts = video.keypoints.filter(k => {
      const id = String(k.id).toLowerCase();
      return id.startsWith('blade_red') || id.startsWith('blade_blue') || id.startsWith('blade_yellow');
    });

    // Find a reference tip point to compute the rotor angle.
    // Try outermost points first (_3 > _2 > _1) across all blade colours.
    // Subtract each blade's angular offset so all three blades give the same rotor angle.
    let firstTarget: number | null = null;
    let sumDiff = 0;
    let countTargetAngle = 0;

    const suffixes = ['_3', '_2', '_1'];
    const bladeGroups = Object.keys(ROTOR_BLADE_OFFSETS);

    for (const suffix of suffixes) {
      for (const group of bladeGroups) {
        const kptName = `${group}${suffix}`;
        const kpt = rotorKpts.find(k => String(k.id).toLowerCase() === kptName);
        if (kpt) {
          const rawAngle = Math.atan2(-(kpt.y - hubY), kpt.x - hubX);
          const bladeOffset = ROTOR_BLADE_OFFSETS[group] ?? 0;
          // Invert rotation direction: target = offset - rawAngle 
          // to make the 3D model rotate opposite to the image detection angles
          // while preserving the point where rawAngle === offset (target = 0)
          const target = bladeOffset - rawAngle;
          
          if (firstTarget === null) {
            firstTarget = target;
            countTargetAngle = 1;
          } else {
            let diff = target - firstTarget;
            while (diff >  Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;
            sumDiff += diff;
            countTargetAngle++;
          }

          if (shouldLog && countTargetAngle === 1) {
            console.log(
              `BladeController: Rotor sync via ${kptName} — detected=${rawAngle.toFixed(3)} rad, ` +
              `offset=${bladeOffset.toFixed(3)} rad, target=${target.toFixed(3)} rad`
            );
          }
        }
      }
      if (countTargetAngle > 0) break;
    }

    let targetAngle: number | null = firstTarget !== null ? (firstTarget + (sumDiff / countTargetAngle)) : null;

    if (targetAngle !== null) {
      // Stage 1: low-pass filter on the raw detected angle to reduce keypoint noise
      if (smoothedAngleRef.current === null) {
        smoothedAngleRef.current = targetAngle;
      } else {
        smoothedAngleRef.current = lerpAngleShortest(
          smoothedAngleRef.current,
          targetAngle,
          Math.min(1, delta * 4)   // ~6% convergence per frame @ 60fps → smoother input
        );
      }

      // Stage 2: model follows the smoothed target (shortest arc, no wrap-around jump)
      rotationNode.current.rotation.z = lerpAngleShortest(
        rotationNode.current.rotation.z,
        smoothedAngleRef.current,
        Math.min(1, delta * 6)     // Increased convergence for better responsiveness
      );
    }
  });

  return null;
};

const OC4Platform = ({ liveViewActive, editMode, showAxes }: { liveViewActive: boolean, editMode?: boolean, showAxes: boolean }) => {
  const MODEL_URL = '/models/OC4.glb'; 
  const groupRef = useRef<THREE.Group>(null);
  const [scene, setScene] = useState<THREE.Group | null>(null);

  return (
    <group 
      ref={groupRef}
      position={[0, 0, 0]}
    >
      <LivePlatformController targetRef={groupRef} active={!liveViewActive && !!editMode} />
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <GLBModel url={MODEL_URL} onModelLoaded={setScene} />
        <BladeController scene={scene} />
        {/* Helper axes to visualize object orientation */}
        {showAxes && <axesHelper args={[2]} />}
      </group>
    </group>
  );
};

export const ModelViewer = ({ editMode = false }: { editMode?: boolean }) => {
  const [currentView, setCurrentView] = useState<CameraView>('live');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);

  return (
    <div className="w-full h-full min-h-0 bg-slate-950 rounded-lg overflow-hidden border border-slate-800 relative group shadow-2xl">
      {/* View Control Button */}
      <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
        <button 
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="bg-black/30 hover:bg-black/50 text-white p-2 rounded-lg backdrop-blur-md border border-white/10 transition-all flex items-center gap-2 shadow-lg"
          title="Change View"
        >
          <LayoutGrid className="w-5 h-5" />
          <span className="text-sm font-medium hidden group-hover:block">View</span>
        </button>

        {/* Dropdown Menu */}
        {isMenuOpen && (
          <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700 rounded-lg shadow-xl p-1 flex flex-col gap-1 min-w-[140px] animate-in fade-in slide-in-from-top-2 z-50">
            <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Camera</div>
            {(Object.keys(VIEW_CONFIGS) as CameraView[]).map((view) => {
              const config = VIEW_CONFIGS[view];
              const Icon = config.icon;
              return (
                <button
                  key={view}
                  onClick={() => {
                    setCurrentView(view);
                    setIsMenuOpen(false);
                  }}
                  className={`flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                    currentView === view 
                      ? 'bg-blue-600 text-white' 
                      : 'text-gray-300 hover:bg-white/10'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {config.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating Display Settings */}
      <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-2 bg-slate-900/80 backdrop-blur-md border border-slate-700 p-3 rounded-lg shadow-xl">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Visualization</div>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-white transition-colors">
          <input 
            type="checkbox" 
            checked={showGrid} 
            onChange={(e) => setShowGrid(e.target.checked)} 
            className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900 w-4 h-4 cursor-pointer" 
          />
          Show Grid
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-white transition-colors">
          <input 
            type="checkbox" 
            checked={showAxes} 
            onChange={(e) => setShowAxes(e.target.checked)} 
            className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900 w-4 h-4 cursor-pointer" 
          />
          Show Axes
        </label>
      </div>

      <Canvas shadows dpr={[1, 2]}>
        <color attach="background" args={['#020617']} />
        <fog attach="fog" args={['#020617', 10, 50]} />
        
        <PerspectiveCamera makeDefault position={[10, 10, 10]} fov={50} />
        
        {currentView === 'live' ? (
           <LiveCameraController active={true} />
        ) : (
           <StaticCameraController view={currentView} active={true} />
        )}
        
        {/* Improved Lighting */}
        <ambientLight intensity={0.7} />
        <directionalLight 
          position={[10, 20, 10]} 
          intensity={1.5} 
          castShadow 
          shadow-mapSize={[1024, 1024]} 
        />
        <pointLight position={[-10, 10, -10]} intensity={0.5} color="#4f46e5" />

        <Suspense fallback={null}>
          <OC4Platform liveViewActive={currentView === 'live'} editMode={editMode} showAxes={showAxes} />
          <ContactShadows resolution={1024} scale={50} blur={2} opacity={0.5} far={10} color="#000000" />
        </Suspense>
        
        {showGrid && (
          <Grid 
            infiniteGrid 
            fadeDistance={50} 
            sectionColor="#3b82f6" 
            cellColor="#1e293b" 
            sectionSize={5} 
            cellSize={1} 
            sectionThickness={1.5}
            cellThickness={0.5}
          />
        )}
        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
        <Environment preset="city" />
      </Canvas>
    </div>
  );
};

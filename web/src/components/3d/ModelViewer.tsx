import { Suspense, useState, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, Environment, useFBX, useGLTF, PerspectiveCamera, CameraControls, ContactShadows, Stars } from '@react-three/drei';
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
  const config = VIEW_CONFIGS[view];

  useEffect(() => {
    if (active && controlsRef.current) {
      controlsRef.current.setLookAt(
        config.position[0], config.position[1], config.position[2],
        config.target[0], config.target[1], config.target[2],
        true // animated
      );
    }
  }, [view, active]);

  return <CameraControls ref={controlsRef} enabled={active} />;
};

// Component to handle different model types
const ModelLoader = ({ url }: { url: string }) => {
  const isGLB = url.endsWith('.glb') || url.endsWith('.gltf');
  
  if (isGLB) {
    return <GLBModel url={url} />;
  }
  return <FBXModel url={url} />;
};

const GLBModel = ({ url }: { url: string }) => {
  const { scene } = useGLTF(url);
  // Enable shadows
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return <primitive object={scene} scale={1} />; 
};

const FBXModel = ({ url }: { url: string }) => {
  const fbx = useFBX(url);
  return <primitive object={fbx} scale={0.01} />; 
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
      // If it is an outlier, just keep the target as previous valid state
      // (This will make the model stay in its last known good position/rotation)
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

const OC4Platform = ({ liveViewActive, editMode, showAxes }: { liveViewActive: boolean, editMode?: boolean, showAxes: boolean }) => {
  const MODEL_URL = '/models/OC4.glb'; 
  const groupRef = useRef<THREE.Group>(null);

  return (
    <group 
      ref={groupRef}
      position={[0, 0, 0]}
    >
      <LivePlatformController targetRef={groupRef} active={!liveViewActive && !!editMode} />
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <ModelLoader url={MODEL_URL} />
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
            <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Cámara</div>
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
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Visualización</div>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-white transition-colors">
          <input 
            type="checkbox" 
            checked={showGrid} 
            onChange={(e) => setShowGrid(e.target.checked)} 
            className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900 w-4 h-4 cursor-pointer" 
          />
          Mostrar Rejilla
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer hover:text-white transition-colors">
          <input 
            type="checkbox" 
            checked={showAxes} 
            onChange={(e) => setShowAxes(e.target.checked)} 
            className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900 w-4 h-4 cursor-pointer" 
          />
          Mostrar Ejes
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

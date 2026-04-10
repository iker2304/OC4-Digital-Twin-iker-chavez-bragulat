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
    position: [0, 15, 0], // Y-axis is vertical (Up)
    target: [0, 0, 0], 
    label: 'Top View',
    icon: LayoutGrid
  },
  side: { 
    position: [15, 0, 0], // X-axis is Right/Left
    target: [0, 0, 0], 
    label: 'Side View',
    icon: Monitor
  },
  front: { 
    position: [0, 0, 15], // Z-axis is Front/Back
    target: [0, 0, 0], 
    label: 'Front View',
    icon: Eye
  },
  iso: { 
    position: [10, 10, 10], 
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
  const q = useRef(new THREE.Quaternion());
  const R = useRef(new THREE.Matrix4());
  const R_inv = useRef(new THREE.Matrix4());
  const tvecVec = useRef(new THREE.Vector3());
  const forward = useRef(new THREE.Vector3());
  const up = useRef(new THREE.Vector3());
  const lookAtPos = useRef(new THREE.Vector3());
  const threeLookAt = useRef(new THREE.Vector3());

  useFrame(() => {
    if (!active) return;
    if (!pose || !pose.rvec || !pose.tvec) return;
    
    // Check if pose is valid (not all zeros)
    if (pose.rvec[0] === 0 && pose.rvec[1] === 0 && pose.rvec[2] === 0 && 
        pose.tvec[0] === 0 && pose.tvec[1] === 0 && pose.tvec[2] === 0) return;

    const rx = pose.rvec[0];
    const ry = pose.rvec[1];
    const rz = pose.rvec[2];
    
    const tx = pose.tvec[0];
    const ty = pose.tvec[1];
    const tz = pose.tvec[2];

    const theta = Math.sqrt(rx*rx + ry*ry + rz*rz);
    
    axis.current.set(
      theta > 0 ? rx / theta : 1,
      theta > 0 ? ry / theta : 0,
      theta > 0 ? rz / theta : 0
    );
    
    q.current.setFromAxisAngle(axis.current, theta);
    R.current.makeRotationFromQuaternion(q.current);
    R_inv.current.copy(R.current).transpose();
    
    tvecVec.current.set(tx, ty, tz);
    const pos = tvecVec.current.applyMatrix4(R_inv.current).negate();
    
    // Position: (x, y, z) -> (x, -y, -z)
    camera.position.set(pos.x, -pos.y, -pos.z);
    
    forward.current.set(0, 0, 1).applyMatrix4(R_inv.current);
    up.current.set(0, 1, 0).applyMatrix4(R_inv.current); // OpenCV Y is Down
    
    lookAtPos.current.copy(pos).add(forward.current);
    
    // Apply Coordinate System Flip to LookAt and Up
    // (x, y, z) -> (x, -y, -z)
    
    threeLookAt.current.set(lookAtPos.current.x, -lookAtPos.current.y, -lookAtPos.current.z);
    
    camera.lookAt(threeLookAt.current);
    
    // Adjust up vector. In CV, Y is down. In Three, Y is up.
    camera.up.set(up.current.x, -up.current.y, -up.current.z).negate(); // Negate because CV Y points down
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

const OC4Platform = () => {
  const MODEL_URL = '/models/OC4.glb'; 

  return (
    <group 
      position={[0, 0, 0]}
      rotation={[-Math.PI / 2, 0, 0]} 
    >
      <ModelLoader url={MODEL_URL} />
      {/* Helper axes to visualize object orientation */}
      <axesHelper args={[2]} /> 
    </group>
  );
};

export const ModelViewer = () => {
  const [currentView, setCurrentView] = useState<CameraView>('iso');
  const [isMenuOpen, setIsMenuOpen] = useState(false);

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
          <OC4Platform />
          <ContactShadows resolution={1024} scale={50} blur={2} opacity={0.5} far={10} color="#000000" />
        </Suspense>
        
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
        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
        <Environment preset="city" />
      </Canvas>
    </div>
  );
};

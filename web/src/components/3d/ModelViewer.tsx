import { Suspense, useState, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, Environment, useGLTF, PerspectiveCamera, CameraControls, ContactShadows, Stars } from '@react-three/drei';
import { useTwinStore } from '../../store/twinStore';
import { useProfileStore } from '../../store/profileStore';
import * as THREE from 'three';
import { Box, Eye, LayoutGrid, Monitor, Video, Upload, Layers } from 'lucide-react';
import { API_BASE_URL } from '../../config/api';
import { Glyph } from '../ui/Glyph';

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
    position: [4.5, 3.8, 4.5],
    target: [0, 0, 0],
    label: 'Live Tracking',
    icon: Video
  },
  top: {
    position: [0, 7.5, 0],
    target: [0, 0, 0],
    label: 'Top View',
    icon: LayoutGrid
  },
  side: {
    position: [7.5, 0, 0],
    target: [0, 0, 0],
    label: 'Side View',
    icon: Monitor
  },
  front: {
    position: [0, 0, 7.5],
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

// Procedural 3D meshes for non-OC4 Digital Twin templates when no custom GLB is selected
const ProceduralTwinMesh = ({ type }: { type: string }) => {
  const rotorRef = useRef<THREE.Group>(null);
  const armJointRef = useRef<THREE.Group>(null);

  useFrame((state, delta) => {
    if (rotorRef.current) {
      rotorRef.current.rotation.y += delta * 6;
    }
    if (armJointRef.current) {
      armJointRef.current.rotation.z = Math.sin(state.clock.elapsedTime * 1.5) * 0.35;
    }
  });

  if (type === 'procedural:bridge') {
    return (
      <group position={[0, 0, 0]}>
        {/* Main Pylons */}
        <mesh position={[-1.8, 1.2, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.25, 2.6, 0.6]} />
          <meshStandardMaterial color="#f59e0b" metalness={0.5} roughness={0.3} />
        </mesh>
        <mesh position={[1.8, 1.2, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.25, 2.6, 0.6]} />
          <meshStandardMaterial color="#f59e0b" metalness={0.5} roughness={0.3} />
        </mesh>
        {/* Bridge Deck */}
        <mesh position={[0, 0.6, 0]} castShadow receiveShadow>
          <boxGeometry args={[5.5, 0.14, 0.9]} />
          <meshStandardMaterial color="#475569" metalness={0.6} roughness={0.4} />
        </mesh>
        {/* Stay Cables */}
        {[-1.2, -0.6, 0.6, 1.2].map((offset, idx) => (
          <mesh key={idx} position={[offset, 1.4, 0]} rotation={[0, 0, offset > 0 ? 0.45 : -0.45]}>
            <cylinderGeometry args={[0.015, 0.015, 1.8, 8]} />
            <meshStandardMaterial color="#94a3b8" />
          </mesh>
        ))}
      </group>
    );
  }

  if (type === 'procedural:robot_arm') {
    return (
      <group position={[0, 0, 0]}>
        {/* Pedestal Base */}
        <mesh position={[0, 0.2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.5, 0.65, 0.4, 24]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.2} />
        </mesh>
        {/* Shoulder */}
        <mesh position={[0, 0.6, 0]} castShadow>
          <sphereGeometry args={[0.32, 20, 20]} />
          <meshStandardMaterial color="#8b5cf6" metalness={0.5} roughness={0.3} />
        </mesh>
        {/* Lower Arm */}
        <group position={[0, 0.6, 0]} ref={armJointRef}>
          <mesh position={[0, 0.8, 0]} castShadow>
            <cylinderGeometry args={[0.16, 0.2, 1.6, 16]} />
            <meshStandardMaterial color="#e2e8f0" metalness={0.6} roughness={0.2} />
          </mesh>
          {/* Elbow */}
          <mesh position={[0, 1.6, 0]} castShadow>
            <sphereGeometry args={[0.24, 16, 16]} />
            <meshStandardMaterial color="#8b5cf6" metalness={0.5} roughness={0.3} />
          </mesh>
          {/* Forearm */}
          <mesh position={[0.5, 1.8, 0]} rotation={[0, 0, -Math.PI / 3]} castShadow>
            <cylinderGeometry args={[0.12, 0.15, 1.2, 16]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.6} roughness={0.3} />
          </mesh>
          {/* End Effector */}
          <mesh position={[1.05, 2.1, 0]} castShadow>
            <boxGeometry args={[0.25, 0.25, 0.25]} />
            <meshStandardMaterial color="#06b6d4" emissive="#0891b2" emissiveIntensity={0.4} />
          </mesh>
        </group>
      </group>
    );
  }

  if (type === 'procedural:uav') {
    return (
      <group position={[0, 0.8, 0]}>
        {/* Central Fuselage */}
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.8, 0.22, 1.1]} />
          <meshStandardMaterial color="#06b6d4" metalness={0.6} roughness={0.3} />
        </mesh>
        {/* Arms & Rotors */}
        {[
          [-1.0, 0.1, -1.0],
          [1.0, 0.1, -1.0],
          [-1.0, 0.1, 1.0],
          [1.0, 0.1, 1.0],
        ].map(([x, y, z], i) => (
          <group key={i} position={[x, y, z]}>
            <mesh position={[-x * 0.5, -0.05, -z * 0.5]} rotation={[0, Math.atan2(x, z), Math.PI / 2]}>
              <cylinderGeometry args={[0.04, 0.04, 1.4, 8]} />
              <meshStandardMaterial color="#334155" />
            </mesh>
            <group ref={i === 0 ? rotorRef : undefined}>
              <mesh>
                <cylinderGeometry args={[0.55, 0.55, 0.02, 16]} />
                <meshStandardMaterial color="#38bdf8" transparent opacity={0.45} />
              </mesh>
            </group>
          </group>
        ))}
      </group>
    );
  }

  return null;
};

// Optimized camera controller using a single matrix for transformations
const LiveCameraController = ({ active }: { active: boolean }) => {
  const { camera } = useThree();
  const { pose } = useTwinStore();

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

    const theta = Math.sqrt(rx * rx + ry * ry + rz * rz);

    axis.current.set(
      theta > 0 ? rx / theta : 1,
      theta > 0 ? ry / theta : 0,
      theta > 0 ? rz / theta : 0
    );

    qObjToCamCv.current.setFromAxisAngle(axis.current, theta);
    objToCamCv4.current.makeRotationFromQuaternion(qObjToCamCv.current);
    objToCamCv3.current.setFromMatrix4(objToCamCv4.current);

    camToObjCv3.current.copy(objToCamCv3.current).transpose();
    tvec.current.set(tx, ty, tz);
    camPosCv.current.copy(tvec.current).applyMatrix3(camToObjCv3.current).multiplyScalar(-1);

    camPosThree.current.copy(camPosCv.current).applyMatrix3(cvToThree.current);
    camera.position.copy(camPosThree.current);

    camToObjThree3.current
      .copy(cvToThree.current)
      .multiply(camToObjCv3.current)
      .multiply(cvToThree.current);

    const e = camToObjThree3.current.elements;
    camToObjThree4.current.set(
      e[0], e[3], e[6], 0,
      e[1], e[4], e[7], 0,
      e[2], e[5], e[8], 0,
      0, 0, 0, 1
    );
    camQuatThree.current.setFromRotationMatrix(camToObjThree4.current);
    camera.quaternion.copy(camQuatThree.current);
    camera.updateMatrixWorld();
  });

  return null;
};

// Component to handle static camera transitions
const StaticCameraController = ({ view, active }: { view: CameraView; active: boolean }) => {
  const controlsRef = useRef<CameraControls>(null);
  const appliedView = useRef<CameraView | null>(null);

  useFrame(() => {
    if (!active || !controlsRef.current) return;
    if (appliedView.current !== view) {
      const config = VIEW_CONFIGS[view];
      controlsRef.current.setLookAt(
        config.position[0], config.position[1], config.position[2],
        config.target[0], config.target[1], config.target[2],
        true
      );
      appliedView.current = view;
    }
  });

  return <CameraControls ref={controlsRef} enabled={active} />;
};

const GLBModel = ({ url, onModelLoaded }: { url: string; onModelLoaded?: (scene: THREE.Group) => void }) => {
  const { scene, animations } = useGLTF(url);
  useEffect(() => {
    if (scene) {
      scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
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
  const prevValidTarget = useRef<{ position: THREE.Vector3; quaternion: THREE.Quaternion } | null>(null);

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

    const newTargetPosition = new THREE.Vector3();
    const newTargetQuaternion = new THREE.Quaternion();

    const nx = Number(navigation?.position?.x) || 0;
    const ny = Number(navigation?.position?.y) || 0;
    const nz = Number(navigation?.position?.z) || 0;
    const npitch = Number(navigation?.pitch) || 0;
    const nyaw = Number(navigation?.yaw) || 0;
    const nroll = Number(navigation?.roll) || 0;
    const hasNav = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) + Math.abs(npitch) + Math.abs(nyaw) + Math.abs(nroll) > 1e-5;

    if (hasNav) {
      newTargetPosition.set(nx * 0.2, nz * 0.2, -ny * 0.2);
      eulerTarget.current.set(
        THREE.MathUtils.degToRad(nroll),
        THREE.MathUtils.degToRad(-nyaw),
        THREE.MathUtils.degToRad(npitch)
      );
      newTargetQuaternion.setFromEuler(eulerTarget.current);
    } else if (hasPose) {
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
    }

    let isOutlier = false;
    if (prevValidTarget.current && hasPose && !hasNav) {
      const angleDiff = prevValidTarget.current.quaternion.angleTo(newTargetQuaternion);
      const posDiff = prevValidTarget.current.position.distanceTo(newTargetPosition);
      if (angleDiff > 0.5 || posDiff > 5.0) {
        isOutlier = true;
      }
    }

    if (!isOutlier) {
      qTarget.current.copy(newTargetQuaternion);
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

    const alpha = Math.min(1, delta * 6);
    if (prevValidTarget.current) {
      group.position.lerp(prevValidTarget.current.position, alpha);
    }
    group.quaternion.slerp(qTarget.current, alpha);
  });

  return null;
};

const ROTOR_BLADE_OFFSETS: Record<string, number> = {
  'blade_blue': (Math.PI / 2),
  'blade_yellow': (Math.PI / 2) + (2 * Math.PI) / 3,
  'blade_red': (Math.PI / 2) + (4 * Math.PI) / 3,
};

function lerpAngleShortest(current: number, target: number, alpha: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return current + diff * alpha;
}

const BladeController = ({ scene, enabled = true }: { scene: THREE.Group | null; enabled?: boolean }) => {
  const rotationNode = useRef<THREE.Object3D | null>(null);
  const smoothedAngleRef = useRef<number | null>(null);

  useEffect(() => {
    if (!scene || !enabled) return;

    const targetNames = [
      'rotate', 'rotation', 'Hub', 'VIS_Hub', 'VIS_Hub_rotation', 'rotor', 'Rotor',
      'Shaft', 'shaft', 'blade_parent', 'Armature', 'RootNode'
    ];

    let foundNode: THREE.Object3D | null = null;

    for (const name of targetNames) {
      const node = scene.getObjectByName(name);
      if (node) {
        foundNode = node;
        break;
      }
    }

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

    if (foundNode && foundNode.name.toLowerCase().includes('hub') && foundNode.children.length === 0) {
      if (foundNode.parent) {
        foundNode = foundNode.parent;
      }
    }

    if (foundNode) {
      rotationNode.current = foundNode;
    }
  }, [scene, enabled]);

  useFrame((_state, delta) => {
    if (!enabled || !rotationNode.current) return;

    const { video, isSimulating } = useTwinStore.getState();

    if (!video.keypoints || video.keypoints.length === 0) {
      if (isSimulating) {
        rotationNode.current.rotation.z += delta * 1.5;
      }
      return;
    }

    const hubKpt = video.keypoints.find(k => String(k.id).toLowerCase() === 'hub');

    let hubX: number;
    let hubY: number;

    if (hubKpt) {
      hubX = hubKpt.x;
      hubY = hubKpt.y;
    } else {
      const rotorKpts = video.keypoints.filter(k => {
        const id = String(k.id).toLowerCase();
        return id.startsWith('blade_red') || id.startsWith('blade_blue') || id.startsWith('blade_yellow');
      });

      if (rotorKpts.length === 0) {
        if (isSimulating) {
          rotationNode.current.rotation.z += delta * 1.5;
        }
        return;
      }

      hubX = rotorKpts.reduce((sum, k) => sum + k.x, 0) / rotorKpts.length;
      hubY = rotorKpts.reduce((sum, k) => sum + k.y, 0) / rotorKpts.length;
    }

    const rotorKpts = video.keypoints.filter(k => {
      const id = String(k.id).toLowerCase();
      return id.startsWith('blade_red') || id.startsWith('blade_blue') || id.startsWith('blade_yellow');
    });

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
          const target = bladeOffset - rawAngle;

          if (firstTarget === null) {
            firstTarget = target;
            countTargetAngle = 1;
          } else {
            let diff = target - firstTarget;
            while (diff > Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;
            sumDiff += diff;
            countTargetAngle++;
          }
        }
      }
      if (countTargetAngle > 0) break;
    }

    const targetAngle: number | null = firstTarget !== null ? (firstTarget + (sumDiff / countTargetAngle)) : null;

    if (targetAngle !== null) {
      if (smoothedAngleRef.current === null) {
        smoothedAngleRef.current = targetAngle;
      } else {
        smoothedAngleRef.current = lerpAngleShortest(
          smoothedAngleRef.current,
          targetAngle,
          Math.min(1, delta * 4)
        );
      }

      rotationNode.current.rotation.z = lerpAngleShortest(
        rotationNode.current.rotation.z,
        smoothedAngleRef.current,
        Math.min(1, delta * 6)
      );
    }
  });

  return null;
};

const TwinAssetObject = ({
  modelUrl,
  enableBladeRotation,
  showAxes,
}: {
  modelUrl: string;
  enableBladeRotation: boolean;
  liveViewActive?: boolean;
  editMode?: boolean;
  showAxes: boolean;
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const [scene, setScene] = useState<THREE.Group | null>(null);
  const isProcedural = modelUrl.startsWith('procedural:');

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      <LivePlatformController targetRef={groupRef} active={true} />
      {isProcedural ? (
        <group>
          <ProceduralTwinMesh type={modelUrl} />
          {showAxes && <axesHelper args={[2]} />}
        </group>
      ) : (
        <group rotation={[-Math.PI / 2, 0, 0]}>
          <GLBModel url={modelUrl || '/models/OC4.glb'} onModelLoaded={setScene} />
          <BladeController scene={scene} enabled={enableBladeRotation} />
          {showAxes && <axesHelper args={[2]} />}
        </group>
      )}
    </group>
  );
};

export const ModelViewer = ({ editMode = false }: { editMode?: boolean }) => {
  const [currentView, setCurrentView] = useState<CameraView>('iso');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [availableModels, setAvailableModels] = useState<{ name: string; url: string }[]>([
    { name: 'OC4.glb (Default Offshore)', url: '/models/OC4.glb' },
    { name: 'OC4-modal.glb (Modal Deflection)', url: '/models/OC4-modal.glb' },
    { name: 'Puente / Viaducto (Procedural)', url: 'procedural:bridge' },
    { name: 'Brazo Robótico 6-DOF (Procedural)', url: 'procedural:robot_arm' },
    { name: 'Dron / UAV Naval (Procedural)', url: 'procedural:uav' },
  ]);

  const activeProfile = useProfileStore(s => s.getActiveProfile());
  const updateProfile = useProfileStore(s => s.updateProfile);
  const modelUrl = activeProfile?.config?.model3dUrl || '/models/OC4.glb';
  const enableBladeRotation = activeProfile?.config?.enableBladeRotation ?? true;

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/models/3d`)
      .then(r => r.json())
      .then(data => {
        if (data?.models && Array.isArray(data.models)) {
          const glbList = data.models
            .filter((m: any) => m.name.endsWith('.glb') || m.name.endsWith('.gltf'))
            .map((m: any) => ({ name: m.name, url: m.url }));
          setAvailableModels([
            ...glbList,
            { name: 'Puente / Viaducto (Procedural)', url: 'procedural:bridge' },
            { name: 'Brazo Robótico 6-DOF (Procedural)', url: 'procedural:robot_arm' },
            { name: 'Dron / UAV Naval (Procedural)', url: 'procedural:uav' },
          ]);
        }
      })
      .catch(() => {});
  }, []);

  const handleSelectModel = (url: string) => {
    if (activeProfile) {
      updateProfile(activeProfile.id, {
        config: {
          ...activeProfile.config,
          model3dUrl: url,
        },
      });
    }
    setIsModelMenuOpen(false);
  };

  const handleUpload3DModel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`${API_BASE_URL}/api/models/upload-3d`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const uploaded = await res.json();
        setAvailableModels(prev => [{ name: uploaded.name, url: uploaded.url }, ...prev]);
        handleSelectModel(uploaded.url);
      }
    } catch (err) {
      console.error('Failed to upload 3D model', err);
    }
  };

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 group">
      {/* Top-Left Active Twin & 3D Asset Selector */}
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
        <div className="relative">
          <button
            onClick={() => setIsModelMenuOpen(!isModelMenuOpen)}
            className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
          >
            {activeProfile ? <Glyph name={activeProfile.icon} size={14} className="text-zinc-400" /> : <Layers className="h-3.5 w-3.5 text-zinc-400" />}
            <span>{activeProfile ? activeProfile.name : 'Modelo 3D'}</span>
            <span className="max-w-[120px] truncate font-mono text-[10px] text-zinc-500">
              {modelUrl.replace('/models/', '')}
            </span>
          </button>

          {isModelMenuOpen && (
            <div className="absolute left-0 z-50 mt-1 flex min-w-[230px] flex-col gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-lg">
              <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                Geometría 3D
              </div>
              {availableModels.map(m => (
                <button
                  key={m.url}
                  onClick={() => handleSelectModel(m.url)}
                  className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                    modelUrl === m.url
                      ? 'bg-zinc-800 text-white font-medium'
                      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                  }`}
                >
                  <span className="truncate">{m.name}</span>
                </button>
              ))}
              <label className="mt-1 flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800">
                <Upload className="h-3.5 w-3.5" />
                <span>Subir archivo .GLB</span>
                <input type="file" accept=".glb,.gltf" className="hidden" onChange={handleUpload3DModel} />
              </label>
            </div>
          )}
        </div>
      </div>

      {/* View Control Button */}
      <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
        <button
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
          title="Cambiar vista"
        >
          <LayoutGrid className="h-3.5 w-3.5 text-zinc-400" />
          <span>Vista</span>
        </button>

        {/* Dropdown Menu */}
        {isMenuOpen && (
          <div className="z-50 flex min-w-[140px] flex-col gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-lg">
            <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Cámara</div>
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
                  className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                    currentView === view
                      ? 'bg-zinc-800 text-white font-medium'
                      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {config.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating Display Settings */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-300">
        <label className="flex cursor-pointer items-center gap-1.5 hover:text-white">
          <input
            type="checkbox"
            checked={showGrid}
            onChange={(e) => setShowGrid(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0"
          />
          Rejilla
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 hover:text-white">
          <input
            type="checkbox"
            checked={showAxes}
            onChange={(e) => setShowAxes(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-0"
          />
          Ejes
        </label>
      </div>

      <Canvas shadows dpr={[1, 2]}>
        <color attach="background" args={['#020617']} />
        <fog attach="fog" args={['#020617', 10, 50]} />

        <PerspectiveCamera makeDefault position={[7.5, 7.5, 7.5]} fov={50} />

        {currentView === 'live' ? (
          <>
            <LiveCameraController active={true} />
            <StaticCameraController view="iso" active={true} />
          </>
        ) : (
          <StaticCameraController view={currentView} active={true} />
        )}

        <ambientLight intensity={0.7} />
        <directionalLight
          position={[10, 20, 10]}
          intensity={1.5}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <pointLight position={[-10, 10, -10]} intensity={0.5} color="#4f46e5" />

        <Suspense fallback={null}>
          <TwinAssetObject
            modelUrl={modelUrl}
            enableBladeRotation={enableBladeRotation}
            liveViewActive={currentView === 'live'}
            editMode={editMode}
            showAxes={showAxes}
          />
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

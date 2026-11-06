/**
 * Multi-mode contour, animated: the "synthetic excitation" view.
 *
 * Instead of fitting one mode to the measurement, this drives the twin with a
 * **sum of every mode we have**:
 *
 *     u(v, t) = Σₖ φₖ(v) · qₖ(t),    qₖ(t) = Aₖ · sin(2π fₖ t + φₖ)
 *
 * The set of frequencies is incommensurate, so the total motion never repeats —
 * it is an endless, plausible vibration of the platform. Amplitude weighs *how
 * much* each mode contributes, phase decides *when*, and the frequency decides
 * *how fast* it breathes; nothing here is a guess about the real sea state, it
 * is the modal model being exercised.
 *
 * Everything happens on the GPU: one attribute per mode and one `vec3` uniform
 * with the three modal coordinates. 684k vertices cost the CPU a single write
 * per frame, and the colour map is computed from the *current* displacement
 * inside the vertex shader — which is what makes it dynamic instead of a static
 * photograph of a mode.
 */
import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useAppStore } from '../../store/appStore';
import { vertexDirections } from '../../lib/oma/modeMap';
import { NATURAL_MODES } from '../../lib/oma/naturalModes';

/** Metres of deformation per unit of gain. Gain 20 → 3 cm on a 1.9 m model. */
const SCALE_PER_GAIN = 0.0015;
/** Phase offsets: the golden angle keeps the modes from lining up. */
const PHASE_STEP = 2.39996;

const RAMP_GLSL = `
vec3 oc4ModeRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c1 = vec3(0.04, 0.09, 0.52);
  vec3 c2 = vec3(0.05, 0.62, 0.78);
  vec3 c3 = vec3(0.18, 0.84, 0.38);
  vec3 c4 = vec3(0.98, 0.86, 0.16);
  vec3 c5 = vec3(0.92, 0.14, 0.10);
  if (t < 0.25) return mix(c1, c2, t / 0.25);
  if (t < 0.50) return mix(c2, c3, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c3, c4, (t - 0.50) / 0.25);
  return mix(c4, c5, (t - 0.75) / 0.25);
}
`;

function collect(root: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) meshes.push(mesh);
    });
    return meshes;
}

const ATTRIBUTE_NAMES = ['aModeA', 'aModeB', 'aModeC'];

/**
 * Amplitude of a mode in the synthetic excitation, from its modal participation:
 * a mode that carries 27 % of the mass should visibly dominate one that carries
 * 15 %. Floored so no mode is invisible.
 */
function amplitudeFor(freqHz: number): number {
    const match = NATURAL_MODES.reduce(
        (best, mode) =>
            Math.abs(mode.freqHz - freqHz) < Math.abs(best.freqHz - freqHz) ? mode : best,
        NATURAL_MODES[0]
    );
    return Math.min(1, Math.max(0.35, match.participation / 30));
}

export function ModeColors({ root }: { root: THREE.Object3D }) {
    const active = useAppStore((state) => state.omaColorMode) !== null;
    const map = useAppStore((state) => state.omaModeMap);
    const gain = useAppStore((state) => state.omaGain);
    const coordinates = useMemo(() => ({ value: new THREE.Vector3() }), []);
    const scale = useMemo(() => ({ value: 0 }), []);

    useEffect(() => {
        const meshes = collect(root);
        const cleanup = () => {
            for (const mesh of meshes) {
                for (const name of ATTRIBUTE_NAMES) {
                    if (mesh.geometry.getAttribute(name)) mesh.geometry.deleteAttribute(name);
                }
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                for (const material of materials) {
                    material.onBeforeCompile = () => undefined;
                    material.customProgramCacheKey = () => '';
                    material.needsUpdate = true;
                }
            }
            useAppStore.setState({ omaBlend: null });
        };

        if (!active || !map) return cleanup;

        const modeCount = Math.min(3, map.modes.length);
        if (modeCount === 0) return cleanup;

        // Expand the per-node vectors once, per mode, into per-vertex attributes.
        const expansions = Array.from({ length: modeCount }, (_, index) =>
            vertexDirections(map, index)
        );
        const total = meshes.reduce(
            (sum, mesh) => sum + (mesh.geometry.getAttribute('position')?.count ?? 0),
            0
        );
        if (total !== map.vertexCount) {
            const message = `malla distinta a la horneada: ${total} vértices frente a ${map.vertexCount}`;
            console.warn(`[mode-map] ${message}`);
            useAppStore.setState({ omaError: message, omaColorMode: null });
            return cleanup;
        }

        let offset = 0;
        for (const mesh of meshes) {
            const count = mesh.geometry.getAttribute('position').count;
            for (let index = 0; index < modeCount; index += 1) {
                const slice = expansions[index].slice(offset * 3, (offset + count) * 3);
                mesh.geometry.setAttribute(
                    ATTRIBUTE_NAMES[index],
                    new THREE.BufferAttribute(slice, 3, true)
                );
            }
            offset += count;

            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const material of materials) {
                material.onBeforeCompile = (shader) => {
                    shader.uniforms.uModeQ = coordinates;
                    shader.uniforms.uModeScale = scale;
                    shader.vertexShader = `attribute vec3 aModeA;
attribute vec3 aModeB;
attribute vec3 aModeC;
uniform vec3 uModeQ;
uniform float uModeScale;
varying vec3 vModeColor;
${RAMP_GLSL}
${shader.vertexShader}`;
                    shader.vertexShader = shader.vertexShader
                        .replace(
                            '#include <begin_vertex>',
                            `#include <begin_vertex>
  vec3 modeOffset = aModeA * uModeQ.x + aModeB * uModeQ.y + aModeC * uModeQ.z;
  transformed += modeOffset * uModeScale;
  vModeColor = oc4ModeRamp(sqrt(clamp(length(modeOffset), 0.0, 1.0)));`
                        );
                    shader.fragmentShader = `varying vec3 vModeColor;\n${shader.fragmentShader}`;
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <color_fragment>',
                        `#include <color_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, vModeColor, 0.85);`
                    );
                };
                material.customProgramCacheKey = () => 'oc4-modes-animated';
                material.needsUpdate = true;
            }
        }

        useAppStore.setState({ omaError: null, omaBlend: map.modes.slice(0, modeCount) });
        return cleanup;
    }, [root, active, map, coordinates, scale]);

    /**
     * The endless excitation. Amplitudes come from the modal participation, the
     * phases are spread with the golden angle, and the frequencies are the ones
     * from the solver — so the sum never repeats and every mode gets its turn.
     */
    useFrame(() => {
        if (!active || !map) return;
        scale.value = gain * SCALE_PER_GAIN;
        const seconds = performance.now() / 1000;
        const count = Math.min(3, map.modes.length);
        const values: number[] = [];
        for (let index = 0; index < count; index += 1) {
            const mode = map.modes[index];
            const angular = 2 * Math.PI * mode.freqHz * seconds + index * PHASE_STEP;
            values.push(amplitudeFor(mode.freqHz) * Math.sin(angular));
        }
        coordinates.value.set(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
    });

    return null;
}

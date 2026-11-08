/**
 * Campo FEM de las palas sobre el gemelo en vivo.
 *
 * La ω no se estima aquí: sale del **ángulo del rotor que fija el trackeo de
 * keypoints** (`rotorAngleAuto`). Derivarlo es lo único que hay que hacer, y la
 * "inercia" del modal es justo la constante de tiempo de ese filtro: con τ baja
 * el mapa sigue el temblor de la medida, con τ alta se queda con la tendencia.
 *
 * Se repinta a 5 Hz y no por frame: escribir 180.000 colores (y 180.000
 * posiciones si se deforma) cuesta milisegundos, no microsegundos.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../../store/appStore';
import { TWIN_MODEL_URL } from '../../lib/env';
import { angleDeltaDeg } from '../../lib/pose/rotorAngle';
import {
    applyBladeField,
    bladeBakeUrl,
    clearBladeField,
    loadBladeBake,
} from '../../lib/fem/bladeFem';
import type { BladeBake } from '../../rotorfem/types';

/** Repintado del campo: 5 Hz es de sobra para un mapa de carga. */
const INTERVAL_MS = 200;

export function BladeFem({ root }: { root: THREE.Object3D }) {
    const enabled = useAppStore((state) => state.bladeFemEnabled);
    const deform = useAppStore((state) => state.bladeFemDeform);
    const nonDimensional = useAppStore((state) => state.bladeFemNonDimensional);
    const field = useAppStore((state) => state.bladeFemField);
    const gain = useAppStore((state) => state.bladeFemGain);
    const inertia = useAppStore((state) => state.bladeFemInertia);
    const opacity = useAppStore((state) => state.bladeFemOpacity);

    const bake = useRef<BladeBake | null>(null);
    const omega = useRef(0);
    const previousAngle = useRef<number | null>(null);
    const previousTime = useRef<number | null>(null);
    /** α filtrada, derivada de la ω que sale del trackeo. */
    const alpha = useRef(0);
    const previousOmega = useRef(0);
    const previousOmegaTime = useRef<number | null>(null);

    // Carga del horneado que corresponde al modelo servido.
    useEffect(() => {
        let cancelled = false;
        loadBladeBake(bladeBakeUrl(TWIN_MODEL_URL))
            .then((data) => {
                if (!cancelled) bake.current = data;
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                useAppStore.setState({
                    bladeFemStatus: {
                        painted: 0,
                        min: 0,
                        max: 0,
                        omega: 0,
                        error: error instanceof Error ? error.message : String(error),
                    },
                });
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Al apagar, se devuelven materiales y geometría.
    useEffect(() => {
        if (enabled) return;
        clearBladeField(root);
        useAppStore.setState({ bladeFemStatus: null });
        previousAngle.current = null;
        previousTime.current = null;
        omega.current = 0;
    }, [enabled, root]);

    // Opacidad del contorno: se aplica a los materiales pintados.
    useEffect(() => {
        root.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh || !mesh.userData.__bladeOriginal) return;
            const material = mesh.material as THREE.MeshStandardMaterial;
            if (!material || Array.isArray(material)) return;
            material.transparent = opacity < 1;
            material.opacity = opacity;
            material.depthWrite = opacity >= 1;
            material.needsUpdate = true;
        });
    }, [root, opacity, enabled]);

    useEffect(() => {
        if (!enabled) return;

        const tick = () => {
            const data = bake.current;
            if (!data) return;
            const angle = useAppStore.getState().rotorAngleAuto;
            const now = performance.now();
            if (angle !== null) {
                // ω = dθ/dt con la inercia como constante de tiempo del filtro.
                if (previousAngle.current !== null && previousTime.current !== null) {
                    const dt = Math.max(1e-3, (now - previousTime.current) / 1000);
                    const deltaDeg = angleDeltaDeg(previousAngle.current, angle);
                    const raw = (deltaDeg * Math.PI) / 180 / dt;
                    const factor = Math.min(1, dt / Math.max(0.05, inertia));
                    omega.current += (raw - omega.current) * factor;
                }
                previousAngle.current = angle;
                previousTime.current = now;
            }

            // α = dω/dt, también filtrada con la misma constante de tiempo. El campo
            // tangencial ya invierte el signo por su cuenta.
            if (previousOmegaTime.current !== null) {
                const dt = Math.max(1e-3, (now - previousOmegaTime.current) / 1000);
                const raw = (omega.current - previousOmega.current) / dt;
                alpha.current += (raw - alpha.current) * Math.min(1, dt / Math.max(0.05, inertia));
            }
            previousOmega.current = omega.current;
            previousOmegaTime.current = now;

            const spin = (((angle ?? 0) * Math.PI) / 180) % (Math.PI * 2);

            const result = applyBladeField(root, data, {
                omega: omega.current,
                alpha: alpha.current,
                spin,
                field,
                deform,
                nonDimensional,
                gain,
                smooth: true,
            });

            useAppStore.setState({
                bladeFemStatus: {
                    painted: result.painted,
                    min: result.min,
                    max: result.max,
                    omega: omega.current,
                    error: result.error,
                },
            });
        };

        tick();
        const timer = window.setInterval(tick, INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [enabled, root, deform, nonDimensional, field, gain, inertia]);

    return null;
}

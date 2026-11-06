import { useEffect, useState } from 'react';
import type { LayoutMode } from '../types';

export interface OrientationInfo {
    layout: LayoutMode;
    angle: number;
    /** True on touch devices: used to pick bigger hit targets, not to pick layout. */
    coarsePointer: boolean;
}

function readAngle(): number {
    const orientation = screen.orientation as ScreenOrientation & { angle?: number };
    if (typeof orientation?.angle === 'number') return orientation.angle;
    const legacy = (window as Window & { orientation?: number }).orientation;
    return typeof legacy === 'number' ? legacy : 0;
}

function readLayout(): LayoutMode {
    const angle = readAngle();
    if (typeof window.matchMedia !== 'function') {
        return angle === 90 || angle === 270 ? 'landscape' : 'portrait';
    }
    // `matchMedia` tracks the *viewport*, which is what the layout depends on.
    // `screen.orientation.angle` is the more reliable signal on Android when the
    // URL bar animates, so either one reporting landscape wins.
    const byMedia = window.matchMedia('(orientation: landscape)').matches;
    const byAngle = angle === 90 || angle === 270;
    if (byMedia || byAngle) return 'landscape';
    return 'portrait';
}

/**
 * Orientation of the *container*, not of the camera. The two layouts share the
 * same components; only their arrangement changes (see `LiveStage` and
 * `Onboarding`).
 */
export function useOrientation(): OrientationInfo {
    const [info, setInfo] = useState<OrientationInfo>(() => ({
        layout: readLayout(),
        angle: readAngle(),
        coarsePointer: typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)').matches : true,
    }));

    useEffect(() => {
        const sync = () => {
            const next = readLayout();
            setInfo((previous) =>
                previous.layout === next && previous.angle === readAngle()
                    ? previous
                    : {
                        layout: next,
                        angle: readAngle(),
                        coarsePointer:
                            typeof window.matchMedia === 'function'
                                ? window.matchMedia('(pointer: coarse)').matches
                                : true,
                    }
            );
        };

        window.addEventListener('resize', sync);
        window.addEventListener('orientationchange', sync);
        const orientation = screen.orientation as ScreenOrientation | undefined;
        orientation?.addEventListener?.('change', sync);
        sync();

        return () => {
            window.removeEventListener('resize', sync);
            window.removeEventListener('orientationchange', sync);
            orientation?.removeEventListener?.('change', sync);
        };
    }, []);

    return info;
}

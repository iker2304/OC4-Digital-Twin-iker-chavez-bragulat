import { Canvas } from '@react-three/fiber';
import { cn } from '../../lib/cn';
import { TwinScene } from './TwinScene';

/**
 * Transparent WebGL canvas that sits *above* the camera video in the z-stack.
 * Its opacity is driven by the blend slider, so both layers can be cross-faded.
 *
 * `active` switches the render loop off when the layer is invisible: a fully
 * transparent canvas still costs battery, and phones notice.
 */
export function TwinLayer({
    className,
    active = true,
    lowDetail = false,
}: {
    className?: string;
    active?: boolean;
    /** While a UI sheet covers the scene we can drop the resolution: the user is
     *  dragging sliders, not studying the model, and every saved pixel is a
     *  cheaper composite over the live camera feed. */
    lowDetail?: boolean;
}) {
    return (
        <Canvas
            className={cn('h-full w-full', className)}
            // Cap the pixel ratio: a 3x retina phone would render 9x the pixels for
            // no visible gain and half the framerate.
            dpr={lowDetail ? 1 : [1, 1.75]}
            frameloop={active ? 'always' : 'never'}
            gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
            camera={{ position: [0, 0.9, 3.2], fov: 60, near: 0.01, far: 200 }}
            onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
        >
            <TwinScene />
        </Canvas>
    );
}

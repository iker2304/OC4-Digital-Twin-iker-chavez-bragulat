import { Camera, Cuboid } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * The cross-fade control between the real camera feed and the digital twin.
 *
 * The slider maps to the opacity of the 3D canvas stacked above the video:
 * 0 → only the camera, 1 → only the twin. Intermediate values produce the
 * "same scene, two domains" effect.
 */
export function BlendSlider({
    value,
    onChange,
    orientation = 'horizontal',
    className,
}: {
    value: number;
    onChange: (value: number) => void;
    orientation?: 'horizontal' | 'vertical';
    className?: string;
}) {
    const vertical = orientation === 'vertical';
    // A vertical range input with `direction: rtl` runs min → bottom, max → top,
    // so the icons have to swap or they would label the wrong end.
    const Leading = vertical ? Cuboid : Camera;
    const Trailing = vertical ? Camera : Cuboid;

    return (
        <div
            className={cn(
                'flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/90 px-3 py-2 shadow-lg',
                vertical && 'h-full flex-col py-3',
                className
            )}
        >
            <Leading
                className={cn('h-4 w-4 shrink-0', vertical ? 'text-sky-400' : 'text-slate-400')}
                aria-hidden
            />
            <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={value}
                aria-label="Mezcla entre cámara real y gemelo digital"
                onChange={(event) => onChange(Number(event.target.value))}
                className={cn(
                    'appearance-none bg-transparent cursor-pointer',
                    vertical
                        ? 'h-full w-6 [writing-mode:vertical-lr] [direction:rtl]'
                        : 'h-6 w-full min-w-32',
                    '[&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-white/15',
                    vertical
                        ? '[&::-webkit-slider-runnable-track]:w-1.5 [&::-webkit-slider-runnable-track]:h-full'
                        : '[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:w-full',
                    '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
                    '[&::-webkit-slider-thumb]:bg-sky-400 [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-sky-500/40',
                    vertical
                        ? '[&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6'
                        : '[&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:mt-[-9px]',
                    '[&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-white/15',
                    '[&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-sky-400'
                )}
            />
            <Trailing
                className={cn('h-4 w-4 shrink-0', vertical ? 'text-slate-400' : 'text-sky-400')}
                aria-hidden
            />
        </div>
    );
}

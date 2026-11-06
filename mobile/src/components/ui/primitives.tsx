import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/* ------------------------------------------------------------------ button */

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    icon?: ReactNode;
    full?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
    primary:
        'bg-sky-500 text-slate-950 hover:bg-sky-400 active:bg-sky-600 font-semibold shadow-lg shadow-sky-500/25',
    ghost: 'bg-white/5 text-slate-100 hover:bg-white/10 active:bg-white/15',
    outline: 'border border-white/15 text-slate-100 hover:bg-white/5 active:bg-white/10',
    danger: 'bg-rose-500/15 text-rose-200 border border-rose-400/30 hover:bg-rose-500/25',
};

export function Button({ variant = 'ghost', icon, full, className, children, ...rest }: ButtonProps) {
    return (
        <button
            type="button"
            className={cn(
                // 44px min height: the smallest comfortable touch target.
                'inline-flex items-center justify-center gap-2 rounded-xl px-4 min-h-11 text-sm',
                'transition-colors select-none disabled:opacity-40 disabled:pointer-events-none',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400',
                VARIANTS[variant],
                full && 'w-full',
                className
            )}
            {...rest}
        >
            {icon}
            {children}
        </button>
    );
}

/* -------------------------------------------------------------------- chip */

export function Chip({
    children,
    tone = 'neutral',
    className,
}: {
    children: ReactNode;
    tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
    className?: string;
}) {
    const tones = {
        neutral: 'bg-white/5 text-slate-300 border-white/10',
        good: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/25',
        warn: 'bg-amber-500/15 text-amber-200 border-amber-400/25',
        bad: 'bg-rose-500/15 text-rose-200 border-rose-400/25',
        info: 'bg-sky-500/15 text-sky-200 border-sky-400/25',
    } as const;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap',
                tones[tone],
                className
            )}
        >
            {children}
        </span>
    );
}

/* ------------------------------------------------------------------- panel */

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                'rounded-2xl border border-white/10 bg-slate-900/70 backdrop-blur-xl p-4 shadow-2xl',
                className
            )}
        >
            {children}
        </div>
    );
}

/* ------------------------------------------------------------------ slider */

interface SliderRowProps {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
    format?: (value: number) => string;
    hint?: string;
}

export function SliderRow({
    label,
    value,
    min,
    max,
    step = 0.01,
    onChange,
    format,
    hint,
}: SliderRowProps) {
    return (
        <label className="block select-none">
            <span className="flex items-baseline justify-between gap-3 text-xs text-slate-300">
                <span className="font-medium">{label}</span>
                <span className="font-mono text-slate-400">{format ? format(value) : value.toFixed(2)}</span>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                className="mt-2 h-6 w-full cursor-pointer appearance-none bg-transparent
          [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full
          [&::-webkit-slider-runnable-track]:bg-white/15
          [&::-webkit-slider-thumb]:mt-[-9px] [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-sky-400 [&::-webkit-slider-thumb]:shadow-lg
          [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-white/15
          [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-sky-400"
            />
            {hint ? <span className="mt-1 block text-[11px] text-slate-500">{hint}</span> : null}
        </label>
    );
}

/* ------------------------------------------------------------------ toggle */

export function Toggle({
    label,
    checked,
    onChange,
    disabled,
}: {
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn(
                'flex w-full items-center justify-between gap-3 rounded-xl px-3 min-h-11 text-sm transition-colors',
                'bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none'
            )}
        >
            <span className="text-slate-200">{label}</span>
            <span
                className={cn(
                    'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                    checked ? 'bg-sky-500' : 'bg-white/15'
                )}
            >
                <span
                    className={cn(
                        'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
                        checked ? 'left-[22px]' : 'left-0.5'
                    )}
                />
            </span>
        </button>
    );
}

/* ------------------------------------------------------------------ metric */

export function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
    return (
        <div className="rounded-xl bg-white/5 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
            <div className={cn('font-mono text-sm text-slate-100', tone)}>{value}</div>
        </div>
    );
}

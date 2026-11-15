import {
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

/* ──────────────────────────────────────────────────────────────
   Button
   ────────────────────────────────────────────────────────────── */
type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'accent';
type ButtonSize = 'xs' | 'sm' | 'md' | 'icon';

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
  accent: 'bg-blue-600 text-white hover:bg-blue-500',
  secondary:
    'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800',
  outline:
    'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800',
  ghost:
    'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
  danger:
    'border border-red-200 bg-white text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-500/10',
};

const buttonSizes: Record<ButtonSize, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1',
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  icon: 'h-8 w-8 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', icon: Icon, className, children, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        className
      )}
      {...rest}
    >
      {Icon && <Icon className={size === 'sm' || size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4'} strokeWidth={1.75} />}
      {children}
    </button>
  )
);
Button.displayName = 'Button';

/* ──────────────────────────────────────────────────────────────
   Card
   ────────────────────────────────────────────────────────────── */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ui-card', className)} {...rest} />;
}

interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon | ReactNode;
  actions?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({ title, description, subtitle, icon: Icon, actions, action, className }: CardHeaderProps) {
  const desc = description ?? subtitle;
  const act = actions ?? action;
  const renderIcon = () => {
    if (!Icon) return null;
    if (isValidElement(Icon)) return <span className="mt-0.5 shrink-0 text-zinc-400">{Icon}</span>;
    const IconComponent = Icon as LucideIcon;
    return <IconComponent className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" strokeWidth={1.75} />;
  };
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800',
        className
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {renderIcon()}
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          {desc && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{desc}</p>}
        </div>
      </div>
      {act && <div className="flex shrink-0 items-center gap-2">{act}</div>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Page header
   ────────────────────────────────────────────────────────────── */
interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, actions, action, className }: PageHeaderProps) {
  const act = actions ?? action;
  return (
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="ui-eyebrow mb-1">{eyebrow}</p>}
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
        )}
      </div>
      {act && <div className="flex flex-wrap items-center gap-2">{act}</div>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Badge & status
   ────────────────────────────────────────────────────────────── */
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
type ToneAlias = Tone | 'default' | 'online' | 'offline' | 'error';

const resolveTone = (t?: ToneAlias): Tone => {
  if (!t || t === 'default' || t === 'offline') return 'neutral';
  if (t === 'online') return 'success';
  if (t === 'error') return 'danger';
  return t;
};

const badgeTones: Record<Tone, string> = {
  neutral: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400',
  warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400',
  danger: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400',
  info: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-400',
};

const dotTones: Record<Tone, string> = {
  neutral: 'bg-zinc-400',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-blue-500',
};

export function Badge({
  tone,
  variant,
  dot = false,
  className,
  children,
}: {
  tone?: ToneAlias;
  variant?: ToneAlias;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const resolved = resolveTone(tone ?? variant);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium',
        badgeTones[resolved],
        className
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dotTones[resolved])} />}
      {children}
    </span>
  );
}

export function StatusDot({
  tone,
  status,
  pulse = false,
}: {
  tone?: ToneAlias;
  status?: ToneAlias;
  pulse?: boolean;
}) {
  const resolved = resolveTone(tone ?? status);
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-50',
            dotTones[resolved]
          )}
        />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', dotTones[resolved])} />
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Stat
   ────────────────────────────────────────────────────────────── */
export function Stat({
  label,
  value,
  hint,
  sub,
  icon: Icon,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  className?: string;
}) {
  const meta = hint ?? sub;
  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
        {Icon && <Icon className="h-4 w-4 text-zinc-400" strokeWidth={1.75} />}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {tone && <StatusDot tone={tone} />}
        <span className="text-lg font-semibold tracking-tight text-zinc-900 tabular-nums dark:text-zinc-50">
          {value}
        </span>
      </div>
      {meta && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{meta}</p>}
    </Card>
  );
}

/* ──────────────────────────────────────────────────────────────
   Empty state
   ────────────────────────────────────────────────────────────── */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon | ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const renderIcon = () => {
    if (!Icon) return null;
    if (isValidElement(Icon)) return Icon;
    const IconComponent = Icon as LucideIcon;
    return <IconComponent className="h-5 w-5 text-zinc-400" strokeWidth={1.75} />;
  };

  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {Icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-400">
          {renderIcon()}
        </div>
      )}
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Segmented control (tabs)
   ────────────────────────────────────────────────────────────── */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode; icon?: LucideIcon }[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-zinc-100/60 p-0.5 dark:border-zinc-800 dark:bg-zinc-900',
        className
      )}
    >
      {items.map(({ value: v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === v
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
          )}
        >
          {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />}
          {label}
        </button>
      ))}
    </div>
  );
}

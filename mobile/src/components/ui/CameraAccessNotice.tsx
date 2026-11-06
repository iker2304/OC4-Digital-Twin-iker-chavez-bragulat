import { AlertTriangle } from 'lucide-react';
import { cameraAccess } from '../../lib/env';
import { cn } from '../../lib/cn';

/**
 * Explains why the camera cannot be used *and* what to do about it.
 *
 * Renders nothing when the API is available, so it is safe to drop anywhere.
 */
export function CameraAccessNotice({
    className,
    compact,
}: {
    className?: string;
    compact?: boolean;
}) {
    const access = cameraAccess();
    if (access.available) return null;

    return (
        <div
            className={cn(
                'rounded-xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-amber-100',
                className
            )}
        >
            <p className="flex items-start gap-2 font-semibold">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{access.message}</span>
            </p>
            {!compact && access.hints.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1.5 pl-6">
                    {access.hints.map((hint) => (
                        <li key={hint}>{hint}</li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

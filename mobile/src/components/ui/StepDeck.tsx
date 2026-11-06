/**
 * `StepDeck`: recorrido vertical de tarjetas a pantalla completa.
 *
 * En táctil se deja el scroll nativo con `scroll-snap` (es lo que mejor se
 * siente en un móvil: inercia real, gestos accesibles). El problema aparece en
 * escritorio: la rueda del ratón produce un desplazamiento incremental que deja
 * las tarjetas a medias. Aquí se intercepta la rueda y las teclas para saltar
 * **una tarjeta por gesto**, que es lo que se espera de un deck.
 *
 * La tarjeta la pone quien lo usa (`<StepCard>`), y este componente solo se
 * encarga del contenedor, del índice activo y de la navegación.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface StepDeckHandle {
    goTo: (index: number) => void;
    next: () => void;
    prev: () => void;
}

interface StepDeckProps {
    count: number;
    /** Se llama cada vez que la tarjeta visible cambia (para la barra de progreso). */
    onIndexChange?: (index: number) => void;
    children: ReactNode;
    className?: string;
}

/** Un gesto de rueda más corto que esto se ignora (ruido de trackpad). */
const WHEEL_THRESHOLD = 12;
/** Tiempo mínimo entre dos saltos: evita que un gesto largo avance varias tarjetas. */
const WHEEL_LOCK_MS = 520;

export const StepDeck = forwardRef<StepDeckHandle, StepDeckProps>(function StepDeck(
    { count, onIndexChange, children, className },
    ref
) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const indexRef = useRef(0);
    const lockUntil = useRef(0);
    const accumulated = useRef(0);
    const [index, setIndex] = useState(0);

    const setActive = useCallback(
        (next: number) => {
            const clamped = Math.min(count - 1, Math.max(0, next));
            if (clamped === indexRef.current) return;
            indexRef.current = clamped;
            setIndex(clamped);
            onIndexChange?.(clamped);
        },
        [count, onIndexChange]
    );

    const goTo = useCallback(
        (target: number) => {
            const container = containerRef.current;
            if (!container) return;
            const cards = Array.from(container.querySelectorAll('[data-step]')) as HTMLElement[];
            cards[Math.min(cards.length - 1, Math.max(0, target))]?.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
            });
            setActive(target);
        },
        [setActive]
    );

    const next = useCallback(() => goTo(indexRef.current + 1), [goTo]);
    const prev = useCallback(() => goTo(indexRef.current - 1), [goTo]);

    useImperativeHandle(ref, () => ({ goTo, next, prev }), [goTo, next, prev]);

    /** Índice activo por intersección: vale para táctil, rueda y barra de scroll. */
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const cards = Array.from(container.querySelectorAll('[data-step]'));
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const position = cards.indexOf(entry.target);
                    if (position >= 0) setActive(position);
                }
            },
            { root: container, threshold: 0.6 }
        );
        cards.forEach((card) => observer.observe(card));
        return () => observer.disconnect();
    }, [setActive]);

    /**
     * Rueda y teclado paginados.
     *
     * Solo se engancha con puntero fino (ratón/trackpad): con el dedo el scroll
     * nativo ya es lo correcto y bloquearlo rompería la inercia.
     */
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        if (window.matchMedia('(pointer: coarse)').matches) return;

        const onWheel = (event: WheelEvent) => {
            // Sin desplazamiento vertical claro, que decida el navegador.
            if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
            event.preventDefault();

            const now = performance.now();
            if (now < lockUntil.current) return;

            accumulated.current += event.deltaY;
            if (Math.abs(accumulated.current) < WHEEL_THRESHOLD) return;

            const direction = accumulated.current > 0 ? 1 : -1;
            accumulated.current = 0;
            lockUntil.current = now + WHEEL_LOCK_MS;
            if (direction > 0) next();
            else prev();
        };

        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            // No robar las flechas dentro de un campo de texto.
            if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
            const jumps: Record<string, () => void> = {
                ArrowDown: next,
                PageDown: next,
                ' ': next,
                ArrowUp: prev,
                PageUp: prev,
                Home: () => goTo(0),
                End: () => goTo(count - 1),
            };
            const action = jumps[event.key];
            if (!action) return;
            event.preventDefault();
            action();
        };

        container.addEventListener('wheel', onWheel, { passive: false });
        window.addEventListener('keydown', onKeyDown);
        return () => {
            container.removeEventListener('wheel', onWheel);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [count, goTo, next, prev]);

    return (
        <div
            ref={containerRef}
            data-step-index={index}
            aria-roledescription="deck"
            className={cn(
                'h-dvh snap-y snap-mandatory overflow-y-auto overscroll-y-none scroll-smooth',
                className
            )}
        >
            {children}
        </div>
    );
});

/** Una tarjeta del deck: pantalla completa, alineada y con `scroll-snap`. */
export function StepCard({
    children,
    className,
    labelledBy,
}: {
    children: ReactNode;
    className?: string;
    labelledBy?: string;
}) {
    return (
        <section
            data-step=""
            aria-labelledby={labelledBy}
            className={cn(
                'flex h-dvh w-full snap-start snap-always items-center justify-center',
                'px-[max(1.25rem,env(safe-area-inset-left))] py-16',
                className
            )}
        >
            {children}
        </section>
    );
}

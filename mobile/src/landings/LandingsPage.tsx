/**
 * `/landings/` — índice de pantallas.
 *
 * La app tiene ya cinco caras distintas (la captura en vivo, dos benchmarks, el
 * resumen de modelos y la calibración FEM) y hasta ahora solo se llegaba a ellas
 * escribiendo la ruta a mano. Esto es solo un menú: cada tarjeta enlaza a una
 * pantalla que ya existe.
 *
 * Para poner un icono propio, basta con dejar el PNG/SVG en `public/landings/` y
 * añadir `image: '/landings/<fichero>.png'` a la tarjeta. Si no hay `image`, se
 * dibuja el icono de lucide.
 */
import {
    Activity,
    Boxes,
    Camera,
    Gauge,
    Waves,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { withBase } from '../lib/env';

interface LandingCard {
    title: string;
    description: string;
    href: string;
    icon: LucideIcon;
    /** Icono propio, si lo hay (ruta relativa a `public/`). */
    image?: string;
    /** Etiqueta corta para saber de un vistazo qué es. */
    tag: string;
}

const CARDS: LandingCard[] = [
    {
        title: 'Live Digital Twin',
        description:
            'La app: cámara, detección de los 11 keypoints en el dispositivo y el gemelo encima, con el campo FEM de las palas en el modal de modos.',
        href: '/',
        icon: Camera,
        tag: 'en vivo',
    },
    {
        title: 'Benchmark',
        description:
            'El banco de pruebas completo: mismo motor, mismos modelos y la misma resolución de pose que la app, con el detalle de cada etapa.',
        href: '/bench/',
        icon: Gauge,
        tag: 'medición',
    },
    {
        title: 'Benchmark público',
        description:
            'El asistente que se abre desde un QR: elige dispositivo y modelo y mide sin dar nada por sabido.',
        href: '/benchmark-public/',
        icon: Boxes,
        tag: 'público',
    },
    {
        title: 'Modelos',
        description:
            'Resumen por clase de cada modelo entrenado, turbina y rotor por separado y la evolución época a época.',
        href: '/model-info/',
        icon: Activity,
        tag: 'entrenamiento',
    },
    {
        title: 'Calibración FEM',
        description:
            'Herramienta para encajar la malla del solver sobre las palas del gemelo y hornear los cinco casos de carga.',
        href: '/rotor-fem/',
        icon: Waves,
        tag: 'herramienta',
    },
];

export function LandingsPage() {
    return (
        <div className="min-h-screen bg-[#070b14] px-4 py-10 text-slate-200">
            <div className="mx-auto w-full max-w-4xl">
                <header className="mb-8">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-400">
                        OC4 · Digital Twin
                    </p>
                    <h1 className="mt-1 text-2xl font-semibold text-slate-50">Pantallas</h1>
                    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
                        Todo lo que hay desplegado, en un sitio. Cada tarjeta abre una pantalla que ya
                        existe; no hay nada nuevo detrás.
                    </p>
                </header>

                <ul className="grid gap-3 sm:grid-cols-2">
                    {CARDS.map((card) => (
                        <li key={card.href}>
                            <a
                                href={withBase(card.href)}
                                className="group flex h-full flex-col rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-sky-400/40 hover:bg-white/[0.06]"
                            >
                                <div className="flex items-center gap-3">
                                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-300">
                                        {card.image ? (
                                            <img
                                                src={withBase(card.image)}
                                                alt=""
                                                className="h-6 w-6 object-contain"
                                            />
                                        ) : (
                                            <card.icon className="h-5 w-5" />
                                        )}
                                    </span>
                                    <div className="min-w-0">
                                        <h2 className="truncate text-sm font-semibold text-slate-100 group-hover:text-white">
                                            {card.title}
                                        </h2>
                                        <p className="text-[10px] uppercase tracking-wider text-slate-500">
                                            {card.tag}
                                        </p>
                                    </div>
                                </div>
                                <p className="mt-3 flex-1 text-[12px] leading-relaxed text-slate-400">
                                    {card.description}
                                </p>
                                <span className="mt-3 font-mono text-[10px] text-slate-600 group-hover:text-sky-400">
                                    {card.href}
                                </span>
                            </a>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

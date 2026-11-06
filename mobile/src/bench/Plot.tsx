/**
 * A dependency-free scatter plot for the benchmark page.
 *
 * SVG by hand on purpose: the page already ships three.js for the app, and adding
 * a charting library for a handful of points on two axes would be the wrong
 * trade. What is needed here is exactly what this does — axes, gridlines, labels
 * and a dot per machine — and nothing else.
 *
 * The interesting question it answers is "does the hardware explain the time?",
 * which is why the axes are configurable: cores, RAM, screen or category on X,
 * and any of the measured stages on Y.
 *
 * **The Y axis switches to a log scale on its own** when the spread is wide. A
 * phone at 870 ms next to desktops at 84 ms is not a subtle difference: on a
 * linear axis the two fast machines collapse into the same pixel. Log keeps all
 * of them readable and the caption says so.
 */
export interface PlotPoint {
    id: string;
    label: string;
    x: number;
    y: number;
    /** Optional colour key, e.g. the device category. */
    group?: string;
    /** Explicit colour; wins over `group`. Used when the points are a series. */
    color?: string;
    /** Tooltip text; defaults to ``label: y``. */
    title?: string;
}

/**
 * Points joined by a line — one machine followed across the models.
 *
 * A separate list instead of a `series` field on every point because the line is
 * about the *shape* between the dots (does this device improve steadily?), and
 * gaps have to be skipped rather than interpolated: a missing cell is missing
 * data, not a zero.
 */
export interface PlotLine {
    id: string;
    color: string;
    points: Array<{ x: number; y: number }>;
}

export interface ScatterPlotProps {
    points: PlotPoint[];
    xLabel: string;
    yLabel: string;
    formatX?: (value: number) => string;
    formatY?: (value: number) => string;
    /**
     * Explicit X ticks, for a *categorical* axis.
     *
     * Without this the grid is spread evenly, and a 1..3 category axis produces
     * labels at 0.8, 1.3, 1.9, 2.4… which then round to "móvil, móvil, portátil,
     * sobremesa, sobremesa". Categories are not a continuum: they get one tick
     * each, exactly where the dots are.
     */
    xTicks?: number[];
    /**
     * Multi-line X tick labels.
     *
     * SVG text does not wrap, so a long categorical label ("yolo-pose-n-640-int8")
     * either overlaps its neighbour or gets clipped. Returning the lines lets the
     * tick say `640n` on one row and `int8` on the next, which is how the model
     * grid is readable without spelling the whole file name.
     */
    xTickLines?: (value: number) => string[];
    /** Colour per group, already resolved to hex. */
    colors?: Record<string, string>;
    /** Lines joining the points of the same series, drawn under the dots. */
    lines?: PlotLine[];
    /**
     * Label every dot with its `label`.
     *
     * Off when the dots are a grid (devices × models): twenty labels over a
     * 340 px plot is noise. The legend and the tooltips carry the names then.
     */
    showPointLabels?: boolean;
    /** Shown instead of the plot when there is nothing to draw. */
    emptyHint?: string;
    /** Why there is nothing to draw, when that is knowable. */
    emptyReason?: string | null;
}

/**
 * The viewBox is wide because the page is: at 340 px the model names on a
 * categorical axis had to be abbreviated to the point of being cryptic. SVG
 * scales, so a wider box costs nothing on a phone and gives the labels room on a
 * desktop.
 */
const WIDTH = 720;
const HEIGHT = 260;
/** Bottom padding grows when the ticks need a second line. */
const PADDING_BASE = { top: 14, right: 16, bottom: 30, left: 46 };
/** Above this ratio a linear axis hides the fast machines. */
const LOG_THRESHOLD = 5;

const DEFAULT_FORMAT = (value: number) => `${Math.round(value * 10) / 10}`;

export function ScatterPlot({
    points,
    xLabel,
    yLabel,
    formatX = DEFAULT_FORMAT,
    formatY = DEFAULT_FORMAT,
    xTicks: fixedXTicks,
    xTickLines,
    colors = {},
    lines = [],
    showPointLabels = true,
    emptyHint = 'Sin datos suficientes para dibujar.',
    emptyReason = null,
}: ScatterPlotProps) {
    if (points.length === 0) {
        return (
            <p className="text-[11px] text-slate-500">
                {emptyHint}
                {emptyReason ? <span className="text-slate-400"> {emptyReason}</span> : null}
            </p>
        );
    }

    const PADDING = { ...PADDING_BASE, bottom: PADDING_BASE.bottom + (xTickLines ? 12 : 0) };
    const innerWidth = WIDTH - PADDING.left - PADDING.right;
    const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;

    const span = (values: number[]) => {
        const min = Math.min(...values);
        const max = Math.max(...values);
        if (min === max) return { min: min - 1, max: max + 1 };
        const pad = (max - min) * 0.12;
        return { min: min - pad, max: max + pad };
    };

    const xRange = fixedXTicks
        ? { min: Math.min(...fixedXTicks) - 0.5, max: Math.max(...fixedXTicks) + 0.5 }
        : span(points.map((point) => point.x));
    const yValues = points.map((point) => point.y);
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);
    const logY = yMin > 0 && yMax / yMin > LOG_THRESHOLD;
    const yRange = logY ? { min: yMin, max: yMax } : span(yValues);

    const projectX = (value: number) =>
        PADDING.left + ((value - xRange.min) / (xRange.max - xRange.min)) * innerWidth;
    const projectY = (value: number) => {
        if (!logY) {
            return PADDING.top + innerHeight - ((value - yRange.min) / (yRange.max - yRange.min)) * innerHeight;
        }
        const low = Math.log10(yRange.min);
        const high = Math.log10(yRange.max);
        const ratio = (Math.log10(Math.max(value, yRange.min)) - low) / Math.max(1e-9, high - low);
        // A little headroom top and bottom so labels are not clipped.
        return PADDING.top + innerHeight * (1 - (0.08 + ratio * 0.84));
    };

    const linearTicks = (range: { min: number; max: number }, count = 4) =>
        Array.from({ length: count + 1 }, (_, index) => range.min + ((range.max - range.min) * index) / count);

    const yTicks = logY
        ? Array.from({ length: 5 }, (_, index) => {
            const low = Math.log10(yRange.min);
            const high = Math.log10(yRange.max);
            return 10 ** (low + ((high - low) * index) / 4);
        })
        : linearTicks(yRange);
    const xTicks = fixedXTicks ?? linearTicks(xRange);

    return (
        <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-auto w-full select-none"
            role="img"
            aria-label={`${yLabel} frente a ${xLabel}${logY ? ' (escala logarítmica)' : ''}`}
        >
            {yTicks.map((value) => (
                <g key={`y-${value}`}>
                    <line
                        x1={PADDING.left}
                        x2={WIDTH - PADDING.right}
                        y1={projectY(value)}
                        y2={projectY(value)}
                        stroke="rgba(148,163,184,0.15)"
                        strokeWidth={1}
                    />
                    <text x={PADDING.left - 4} y={projectY(value) + 3} textAnchor="end" fontSize={8} fill="#94a3b8">
                        {formatY(value)}
                    </text>
                </g>
            ))}
            {xTicks.map((value) => (
                <g key={`x-${value}`}>
                    <line
                        y1={PADDING.top}
                        y2={HEIGHT - PADDING.bottom}
                        x1={projectX(value)}
                        x2={projectX(value)}
                        stroke="rgba(148,163,184,0.1)"
                        strokeWidth={1}
                    />
                    <text
                        x={projectX(value)}
                        y={HEIGHT - PADDING.bottom + 10}
                        textAnchor="middle"
                        fontSize={8}
                        fill="#94a3b8"
                    >
                        {(xTickLines ? xTickLines(value) : [formatX(value)]).map((line, index) => (
                            <tspan key={line} x={projectX(value)} dy={index === 0 ? 0 : 9}>
                                {line}
                            </tspan>
                        ))}
                    </text>
                </g>
            ))}

            <text x={PADDING.left + innerWidth / 2} y={HEIGHT - 4} textAnchor="middle" fontSize={9} fill="#cbd5e1">
                {xLabel}
            </text>
            <text
                x={10}
                y={PADDING.top + innerHeight / 2}
                textAnchor="middle"
                fontSize={9}
                fill="#cbd5e1"
                transform={`rotate(-90 10 ${PADDING.top + innerHeight / 2})`}
            >
                {yLabel}
                {logY ? ' · log' : ''}
            </text>

            {lines.map((line) => (
                <polyline
                    key={`line-${line.id}`}
                    points={line.points
                        .slice()
                        .sort((left, right) => left.x - right.x)
                        .map((point) => `${projectX(point.x)},${projectY(point.y)}`)
                        .join(' ')}
                    fill="none"
                    stroke={line.color}
                    strokeWidth={1.4}
                    strokeOpacity={0.55}
                    strokeLinejoin="round"
                />
            ))}

            {points.map((point, index) => {
                const cx = projectX(point.x);
                const cy = projectY(point.y);
                const color = point.color || (point.group && colors[point.group]) || '#38bdf8';
                // Alternate above/below so two close dots stay readable.
                const above = index % 2 === 0;
                return (
                    <g key={point.id}>
                        <circle cx={cx} cy={cy} r={4.5} fill={color} fillOpacity={0.85} stroke="#0f172a" strokeWidth={1}>
                            <title>{point.title ?? `${point.label}: ${formatY(point.y)}`}</title>
                        </circle>
                        {showPointLabels && point.label ? (
                            <text x={cx} y={above ? cy - 8 : cy + 13} textAnchor="middle" fontSize={8} fill="#e2e8f0">
                                {point.label}
                            </text>
                        ) : null}
                    </g>
                );
            })}
        </svg>
    );
}

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useTwinStore } from '../../store/twinStore';

export const RealTimeChart = ({ metric }: { metric: 'roll' | 'pitch' | 'yaw' | 'x' | 'y' | 'z' }) => {
  const history = useTwinStore((state) => state.history[metric]);

  const getLabel = (m: string) => {
    if (['roll', 'pitch', 'yaw'].includes(m)) return `${m} (°)`;
    return `${m} (m)`;
  };

  return (
    <div className="h-[180px] w-full rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">{getLabel(metric)}</h4>
      <div className="h-[calc(100%-20px)] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={history}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
            <XAxis
              dataKey="timestamp"
              tick={false}
              stroke="var(--chart-axis)"
              domain={['dataMin', 'dataMax']}
            />
            <YAxis stroke="var(--chart-axis)" tick={{ fontSize: 10 }} width={36} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--chart-tooltip-bg)',
                borderColor: 'var(--chart-tooltip-border)',
                color: 'var(--chart-tooltip-fg)',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(label) => new Date(label).toLocaleTimeString()}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#2563eb"
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

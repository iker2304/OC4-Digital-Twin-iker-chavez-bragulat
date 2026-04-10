import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useTwinStore } from '../../store/twinStore';

export const RealTimeChart = ({ metric }: { metric: 'roll' | 'pitch' | 'yaw' | 'x' | 'y' | 'z' }) => {
  const history = useTwinStore((state) => state.history[metric]);

  const getLabel = (m: string) => {
    if (['roll', 'pitch', 'yaw'].includes(m)) return `${m} (deg)`;
    return `${m} (m)`;
  };

  return (
    <div className="w-full h-[250px] bg-white p-4 rounded-lg border border-gray-200 dark:bg-gray-800 dark:border-gray-700">
      <h3 className="text-sm font-medium text-gray-600 mb-2 capitalize dark:text-gray-400">{getLabel(metric)}</h3>
      <div className="w-full h-[calc(100%-24px)]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={history}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
            <XAxis 
              dataKey="timestamp" 
              tick={false} 
              stroke="var(--chart-axis)"
              domain={['dataMin', 'dataMax']}
            />
            <YAxis stroke="var(--chart-axis)" domain={['auto', 'auto']} />
            <Tooltip 
              contentStyle={{
                backgroundColor: 'var(--chart-tooltip-bg)',
                borderColor: 'var(--chart-tooltip-border)',
                color: 'var(--chart-tooltip-fg)',
              }}
              labelFormatter={(label) => new Date(label).toLocaleTimeString()}
            />
            <Line 
              type="monotone" 
              dataKey="value" 
              stroke="#3b82f6" 
              strokeWidth={2} 
              dot={false} 
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

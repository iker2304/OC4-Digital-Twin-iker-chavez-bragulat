import {
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area
} from 'recharts';

interface StructuralHistory {
  timestamp: number;
  mooringTension: number; // kN
  towerStress: number; // MPa
  fatigueLife: number; // % used
}

interface StructuralTrendsChartProps {
  data: StructuralHistory[];
}

const CustomTooltip = ({ active, payload, label }: { active?: boolean, payload?: any[], label?: string | number }) => {
  if (active && payload && payload.length) {
    const time = new Date(label || 0).toLocaleTimeString();
    return (
      <div className="bg-slate-800 border border-slate-700 p-3 rounded-lg shadow-xl text-xs text-white">
        <p className="font-bold mb-2 border-b border-slate-600 pb-1">{time}</p>
        {payload.map((entry: { color: string; name: string; value: string | number; unit: string }, index: number) => (
          <p key={index} style={{ color: entry.color }} className="flex justify-between gap-4 mb-1">
            <span>{entry.name}:</span>
            <span className="font-mono">{typeof entry.value === 'number' ? entry.value.toFixed(2) : entry.value} {entry.unit}</span>
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export default function StructuralTrendsChart({ data }: StructuralTrendsChartProps) {
  // Take only last 300 points (approx 5 seconds at 60Hz, or 5 minutes at 1Hz)
  // Increased from 60 to prevent "frozen" look on high-freq updates
  const chartData = data.slice(-300);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart
        data={chartData}
        margin={{ top: 10, right: 30, left: 10, bottom: 5 }}
      >
        <defs>
          <linearGradient id="colorStress" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/>
            <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
          </linearGradient>
          <linearGradient id="colorTension" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
        
        <XAxis 
          dataKey="timestamp" 
          tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}
          tick={{ fill: '#94a3b8', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          minTickGap={30}
        />
        
        {/* Left Axis: Stress (MPa) */}
        <YAxis 
          yAxisId="left"
          orientation="left"
          stroke="#ef4444"
          tick={{ fill: '#ef4444', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          domain={['auto', 'auto']}
          label={{ value: 'Stress (MPa)', angle: -90, position: 'insideLeft', fill: '#ef4444', fontSize: 10, offset: 0 }}
        />

        {/* Right Axis: Tension (kN) */}
        <YAxis 
          yAxisId="right"
          orientation="right"
          stroke="#3b82f6"
          tick={{ fill: '#3b82f6', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          domain={['auto', 'auto']}
          label={{ value: 'Mooring (kN)', angle: 90, position: 'insideRight', fill: '#3b82f6', fontSize: 10, offset: 0 }}
        />
        
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '5px' }} iconType="circle" />

        <Area
          yAxisId="left"
          type="monotone"
          dataKey="towerStress"
          name="Tower Stress"
          unit="MPa"
          stroke="#ef4444"
          fillOpacity={1}
          fill="url(#colorStress)"
          strokeWidth={2}
          isAnimationActive={false}
        />

        <Area
          yAxisId="right"
          type="monotone"
          dataKey="mooringTension"
          name="Line Tension"
          unit="kN"
          stroke="#3b82f6"
          fillOpacity={1}
          fill="url(#colorTension)"
          strokeWidth={2}
          strokeDasharray="5 5"
          isAnimationActive={false}
        />

      </ComposedChart>
    </ResponsiveContainer>
  );
}

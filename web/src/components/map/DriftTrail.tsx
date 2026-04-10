import React, { useMemo } from 'react';
import { Polyline } from 'react-leaflet';

interface DriftTrailProps {
  path: [number, number][];
}

const DriftTrail = React.memo(({ path }: DriftTrailProps) => {
  if (path.length < 2) return null;

  // Optimization: Reduce the number of points rendered if the path is long
  // to avoid rendering too many segments or vertices.
  const simplifiedPath = useMemo(() => {
    if (path.length <= 50) return path;
    // Keep first, last, and every Nth point
    const step = Math.ceil(path.length / 50);
    return path.filter((_, i) => i === 0 || i === path.length - 1 || i % step === 0);
  }, [path]);

  // Use a single Polyline for better performance instead of multiple segments
  return (
    <Polyline 
      positions={simplifiedPath} 
      pathOptions={{ 
        color: 'cyan', 
        opacity: 0.6,
        weight: 4
      }} 
    />
  );
});

export default DriftTrail;

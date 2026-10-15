import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Frame, GridConfig } from './grid.ts';

type Inspection = { row: number; col: number; x: number; y: number; config: GridConfig };

export function cellAt(lon: number, lat: number, config: GridConfig) {
  const { bounds, rows, cols } = config;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < bounds.west || lon >= bounds.east || lat <= bounds.south || lat > bounds.north) return null;
  return { row: Math.floor((bounds.north - lat) / (bounds.north - bounds.south) * rows),
    col: Math.floor((lon - bounds.west) / (bounds.east - bounds.west) * cols) };
}

export function useDemandInspection(frame: Frame | null, config: GridConfig | null) {
  const [inspection, setDemandTooltip] = useState<Inspection | null>(null);
  useEffect(() => {
    const clear = () => setDemandTooltip(null);
    window.addEventListener('simulation-reset', clear);
    return () => window.removeEventListener('simulation-reset', clear);
  }, []);
  const inspectDemand = useCallback((lon: number, lat: number, x: number, y: number) => {
    const cell = config && cellAt(lon, lat, config);
    setDemandTooltip(cell && config ? { ...cell, config, x: Math.max(12, Math.min(x + 14, window.innerWidth - 280)),
      y: Math.max(12, Math.min(y - 160, window.innerHeight - 180)) } : null);
  }, [config]);
  const lookup = useMemo(() => {
    const cols = config?.cols ?? 0;
    return {
      metrics: new Map(frame?.cell_metrics?.map(metric => [metric[0] * cols + metric[1], metric])),
      density: new Map(frame?.cells.map(([row, col, density]) => [row * cols + col, density])),
    };
  }, [frame, config]);
  const demandTooltip = useMemo(() => {
    if (!inspection || !config || inspection.config !== config || !frame?.cell_metrics) return null;
    const metrics = lookup.metrics.get(inspection.row * config.cols + inspection.col);
    const density = lookup.density.get(inspection.row * config.cols + inspection.col) ?? 0;
    return { ...inspection, generated: metrics?.[2] ?? 0, served: metrics?.[3] ?? 0, unmet: metrics?.[4] ?? 0,
      demandIndex: Math.round(density * 100), pressureLabel: `Modeled demand · ~${Math.round((config.bounds.north - config.bounds.south) / config.rows * 111320)} m cell` };
  }, [inspection, frame, config, lookup]);
  return { demandTooltip, setDemandTooltip, inspectDemand };
}

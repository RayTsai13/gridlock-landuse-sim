import { useCallback, useMemo, useState } from 'react';
import type { Feature, Polygon } from 'geojson';
import type { Frame, GridConfig } from './grid.ts';

type Inspection = { row: number; col: number; x: number; y: number };

export function cellAt(lon: number, lat: number, config: GridConfig) {
  const { bounds, rows, cols } = config;
  if (lon < bounds.west || lon >= bounds.east || lat <= bounds.south || lat > bounds.north) return null;
  return { row: Math.floor((bounds.north - lat) / (bounds.north - bounds.south) * rows),
    col: Math.floor((lon - bounds.west) / (bounds.east - bounds.west) * cols) };
}

export function useDemandInspection(frame: Frame | null, config: GridConfig | null) {
  const [inspection, setDemandTooltip] = useState<Inspection | null>(null);
  const inspectDemand = useCallback((lon: number, lat: number, x: number, y: number) => {
    const cell = config && cellAt(lon, lat, config);
    setDemandTooltip(cell ? { ...cell, x: Math.max(12, Math.min(x + 14, window.innerWidth - 280)),
      y: Math.max(12, Math.min(y - 160, window.innerHeight - 180)) } : null);
  }, [config]);
  const demandTooltip = useMemo(() => {
    if (!inspection || !frame?.cell_metrics) return null;
    const metrics = frame.cell_metrics.find(([row, col]) => row === inspection.row && col === inspection.col);
    const density = frame.cells.find(([row, col]) => row === inspection.row && col === inspection.col)?.[2] ?? 0;
    return { ...inspection, generated: metrics?.[2] ?? 0, served: metrics?.[3] ?? 0, unmet: metrics?.[4] ?? 0,
      demandIndex: Math.round(density * 100), pressureLabel: 'Modeled cell demand' };
  }, [inspection, frame]);
  const outline = useMemo<Feature<Polygon> | null>(() => {
    if (!demandTooltip || !config) return null;
    const width = (config.bounds.east - config.bounds.west) / config.cols;
    const height = (config.bounds.north - config.bounds.south) / config.rows;
    const west = config.bounds.west + demandTooltip.col * width;
    const north = config.bounds.north - demandTooltip.row * height;
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[
      [west, north], [west + width, north], [west + width, north - height], [west, north - height], [west, north],
    ]] } };
  }, [demandTooltip, config]);
  return { demandTooltip, setDemandTooltip, inspectDemand, outline };
}

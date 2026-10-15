/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { cellAt, useDemandInspection } from '../useDemandInspection.ts';
import type { Frame, GridConfig } from '../grid.ts';

const config: GridConfig = { bounds: { west: 0, east: 2, south: 0, north: 2 }, rows: 2, cols: 2 };

it('identifies canonical cells and rejects out-of-bounds coordinates', () => {
  expect(cellAt(0.5, 1.5, config)).toEqual({ row: 0, col: 0 });
  expect(cellAt(1.5, 0.5, config)).toEqual({ row: 1, col: 1 });
  expect(cellAt(2, 1, config)).toBeNull();
  expect(cellAt(0, 2, config)).toEqual({ row: 0, col: 0 });
  expect(cellAt(1, 0, config)).toBeNull();
  expect(cellAt(NaN, 1, config)).toBeNull();
});

it('reports physical metrics independently of saturation and display filtering', () => {
  const frame: Frame = { timestamp: 1, cells: [[0, 0, 1]], cell_metrics: [[0, 0, 12000, 2000, 10000], [1, 1, 10, 9, 1]] };
  const { result } = renderHook(() => useDemandInspection(frame, config));
  act(() => result.current.inspectDemand(0.5, 1.5, 100, 100));
  expect(result.current.demandTooltip?.unmet).toBe(10000);
  act(() => result.current.inspectDemand(1.5, 0.5, 100, 100));
  expect(result.current.demandTooltip?.unmet).toBe(1);
  expect(result.current.demandTooltip?.demandIndex).toBe(0);
});

it('clears stale inspection when the grid changes and on explicit leave', () => {
  const frame: Frame = { timestamp: 1, cells: [], cell_metrics: [[0, 0, 5, 2, 3]] };
  const { result, rerender } = renderHook(({ grid }) => useDemandInspection(frame, grid), { initialProps: { grid: config } });
  act(() => result.current.inspectDemand(0.5, 1.5, 100, 100));
  expect(result.current.demandTooltip?.unmet).toBe(3);
  rerender({ grid: { ...config, rows: 4, cols: 4 } });
  expect(result.current.demandTooltip).toBeNull();
  act(() => result.current.inspectDemand(0.1, 1.9, 100, 100));
  expect(result.current.demandTooltip).not.toBeNull();
  act(() => window.dispatchEvent(new Event('simulation-reset')));
  expect(result.current.demandTooltip).toBeNull();
  act(() => result.current.setDemandTooltip(null));
  expect(result.current.demandTooltip).toBeNull();
});

it('distinguishes adjacent quarter-cells without interpolating totals', () => {
  const fine = { ...config, rows: 4, cols: 4 };
  const frame: Frame = { timestamp: 1, cells: [], cell_metrics: [
    [0, 0, 10, 2, 8], [0, 1, 20, 4, 16], [1, 0, 30, 6, 24], [1, 1, 40, 8, 32],
  ] };
  const { result } = renderHook(() => useDemandInspection(frame, fine));
  for (const [lon, lat, unmet] of [[0.25, 1.75, 8], [0.75, 1.75, 16], [0.25, 1.25, 24], [0.75, 1.25, 32]]) {
    act(() => result.current.inspectDemand(lon, lat, 100, 100));
    expect(result.current.demandTooltip?.unmet).toBe(unmet);
  }
});

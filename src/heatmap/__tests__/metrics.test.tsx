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
});

it('reports physical metrics independently of saturation and display filtering', () => {
  const frame: Frame = { timestamp: 1, cells: [[0, 0, 1]], cell_metrics: [[0, 0, 12000, 2000, 10000], [1, 1, 10, 9, 1]] };
  const { result } = renderHook(() => useDemandInspection(frame, config));
  act(() => result.current.inspectDemand(0.5, 1.5, 100, 100));
  expect(result.current.demandTooltip?.unmet).toBe(10000);
  expect(result.current.outline?.geometry.coordinates[0]).toEqual([[0, 2], [1, 2], [1, 1], [0, 1], [0, 2]]);
  act(() => result.current.inspectDemand(1.5, 0.5, 100, 100));
  expect(result.current.demandTooltip?.unmet).toBe(1);
  expect(result.current.demandTooltip?.demandIndex).toBe(0);
});

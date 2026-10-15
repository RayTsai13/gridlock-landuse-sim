import { describe, expect, it, vi } from 'vitest';
import { createRasterizer, densityColor, rasterLatitude, smoothField } from '../raster.ts';
import type { RasterResponse } from '../raster.ts';
import { RasterQueue } from '../rasterQueue.ts';
import type { RasterWorker } from '../rasterQueue.ts';
import type { CellTuple, GridConfig } from '../grid.ts';

const config: GridConfig = {
  rows: 10, cols: 8,
  bounds: { west: -122.35, east: -122.3233, north: 47.62, south: 47.59754 },
};

describe('continuous density raster', () => {
  it('keeps a constant field constant away from boundaries', () => {
    const result = smoothField(new Float32Array(400).fill(0.7), 20, 20, 0.64, 0.64);
    expect(result[10 * 20 + 10]).toBeCloseTo(0.7, 6);
    expect(result[0]).toBeLessThan(0.7);
  });

  it('smooths an impulse symmetrically without overshoot', () => {
    const values = new Float32Array(441);
    values[220] = 1;
    const result = smoothField(values, 21, 21, 0.64, 0.64);
    expect(result[220]).toBeLessThan(1);
    expect(result[219]).toBeGreaterThan(0);
    expect(result[219]).toBe(result[221]);
    expect(result[199]).toBe(result[241]);
    expect(result.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    expect(Math.min(...result)).toBeGreaterThanOrEqual(0);
  });

  it('renders empty frames transparently and allocates eight pixels per cell', () => {
    const result = createRasterizer(config, null)([]);
    expect([result.width, result.height]).toEqual([64, 80]);
    expect(result.pixels.filter((_, index) => index % 4 === 3).every(alpha => alpha === 0)).toBe(true);
  });

  it('keeps the northwestern hotspot in the northwestern raster', () => {
    const result = createRasterizer(config, null)([[2, 2, 1]]);
    let maximum = 0;
    let peak = 0;
    for (let index = 3; index < result.pixels.length; index += 4) {
      if (result.pixels[index] > maximum) { maximum = result.pixels[index]; peak = (index - 3) / 4; }
    }
    expect(maximum).toBeGreaterThan(0);
    expect(Math.floor(peak / result.width)).toBeLessThan(result.height / 2);
    expect(peak % result.width).toBeLessThan(result.width / 2);
  });

  it('uses fixed colors rather than rescaling every frame', () => {
    const rasterize = createRasterizer(config, null);
    const cells: CellTuple[] = Array.from({ length: config.rows * config.cols }, (_, index) => [Math.floor(index / config.cols), index % config.cols, 0.64]);
    const first = rasterize(cells);
    const second = rasterize(cells);
    expect(first.pixels).toEqual(second.pixels);
    const center = (40 * first.width + 32) * 4;
    expect(Array.from(first.pixels.slice(center, center + 4))).toEqual(densityColor(0.64));
    expect(densityColor(0.1)[3]).toBe(0);
  });

  it('falls back to unshaped rendering for an incompatible mask', () => {
    const cells: CellTuple[] = [[4, 4, 1]];
    const mask = { ...config, bounds: { ...config.bounds, west: -123 }, sub: 2, weights: new Float32Array(320) };
    expect(createRasterizer(config, mask)(cells).pixels).toEqual(createRasterizer(config, null)(cells).pixels);
  });

  it('respects an empty building mask and Mercator row alignment', () => {
    const mask = { ...config, sub: 2, weights: new Float32Array(320) };
    const result = createRasterizer(config, mask)([[4, 4, 1]]);
    expect(result.pixels.filter((_, index) => index % 4 === 3).every(alpha => alpha === 0)).toBe(true);
    expect(rasterLatitude(config, -0.5, 80)).toBeCloseTo(config.bounds.north, 10);
    expect(rasterLatitude(config, 79.5, 80)).toBeCloseTo(config.bounds.south, 10);
    expect(rasterLatitude(config, 10, 80)).toBeGreaterThan(rasterLatitude(config, 70, 80));
  });
});

describe('raster worker scheduling', () => {
  function setup() {
    const worker: RasterWorker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
    const accept = vi.fn();
    const fail = vi.fn();
    const queue = new RasterQueue(worker, { type: 'init', config, mask: null }, accept, fail);
    const finish = (id: number) => worker.onmessage?.call(worker as Worker, { data: { id } as RasterResponse } as MessageEvent<RasterResponse>);
    return { worker, accept, fail, queue, finish };
  }

  it('keeps one active job and replaces the pending frame with the latest', () => {
    const { worker, accept, queue, finish } = setup();
    queue.submit([[0, 0, 0.2]]);
    queue.submit([[0, 0, 0.4]]);
    queue.submit([[0, 0, 0.8]]);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    finish(1);
    expect(accept).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'render', id: 3, cells: [[0, 0, 0.8]] });
    finish(3);
    expect(accept).toHaveBeenCalledOnce();
  });

  it('discards results after resets or disposal', () => {
    const { worker, accept, queue, finish } = setup();
    queue.submit([[0, 0, 1]]);
    queue.invalidate();
    finish(1);
    expect(accept).not.toHaveBeenCalled();
    queue.submit([[0, 0, 1]]);
    const late = worker.onmessage;
    queue.dispose();
    late?.call(worker as Worker, { data: { id: 3 } } as MessageEvent<RasterResponse>);
    expect(accept).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates failed workers and reports failure', () => {
    const { worker, fail } = setup();
    worker.onerror?.call(worker as Worker, {} as ErrorEvent);
    expect(fail).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

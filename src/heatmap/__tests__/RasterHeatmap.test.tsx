// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RasterHeatmap } from '../RasterHeatmap.tsx';
import type { Frame, GridConfig } from '../grid.ts';
import type { RasterResponse } from '../raster.ts';

const state = vi.hoisted(() => {
  const layers = new Map<string, unknown>([['water', {}]]);
  const sources = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const map = {
    getStyle: vi.fn(() => ({} as object | undefined)),
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => sources.get(id),
    addLayer: vi.fn((layer: { id: string }) => layers.set(layer.id, layer)),
    addSource: vi.fn((id: string) => sources.set(id, { play: vi.fn(), pause: vi.fn() })),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    isSourceLoaded: () => true,
    getBounds: () => ({ getWest: () => -123, getEast: () => -122, getSouth: () => 47, getNorth: () => 48 }),
    triggerRepaint: vi.fn(),
    on: (event: string, callback: () => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(callback);
      listeners.set(event, handlers);
    },
    off: (event: string, callback: () => void) => listeners.get(event)?.delete(callback),
  };
  return { layers, sources, listeners, map, current: { getMap: () => map } };
});

vi.mock('react-map-gl/maplibre', () => ({ useMap: () => ({ current: state.current }) }));

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<RasterResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  finish(id = 1) {
    this.onmessage?.({ data: { id, width: 16, height: 16, pixels: new Uint8ClampedArray(1024), generationMs: 4 } } as MessageEvent<RasterResponse>);
  }
}

const config: GridConfig = { rows: 2, cols: 2, bounds: { west: -122.4, east: -122.3, north: 47.7, south: 47.6 } };
const frame: Frame = { timestamp: 1, cells: [[0, 0, 0.8]] };
const paint = vi.fn();
const clear = vi.fn();
const diagnostics = vi.fn();

beforeEach(() => {
  FakeWorker.instances = [];
  vi.clearAllMocks();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('ImageData', class { constructor() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: paint, clearRect: clear } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('raster map lifecycle', () => {
  it('uploads only changed canvases and disposes resources when hidden', () => {
    const { unmount } = render(<RasterHeatmap frame={frame} config={config} builtMass={null} beforeId="water" onDiagnostics={diagnostics} />);
    const worker = FakeWorker.instances[0];
    act(() => worker.finish());
    expect(paint).toHaveBeenCalledOnce();
    const source = state.sources.get('heatmap-raster') as { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
    act(() => state.listeners.get('render')?.forEach(callback => callback()));
    act(() => state.listeners.get('render')?.forEach(callback => callback()));
    expect(source.play).toHaveBeenCalledOnce();
    expect(source.pause).toHaveBeenCalledOnce();
    unmount();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(state.sources.size).toBe(0);
    expect(state.listeners.get('render')?.size).toBe(0);
  });

  it('clears on reset and ignores a result already in flight', () => {
    const { rerender } = render(<RasterHeatmap frame={frame} config={config} builtMass={null} beforeId="water" onDiagnostics={diagnostics} />);
    rerender(<RasterHeatmap frame={null} config={config} builtMass={null} beforeId="water" onDiagnostics={diagnostics} />);
    act(() => FakeWorker.instances[0].finish());
    expect(clear).toHaveBeenCalledOnce();
    expect(paint).not.toHaveBeenCalled();
  });

  it('restarts for mask arrival and grid replacement using the latest frame', () => {
    const { rerender } = render(<RasterHeatmap frame={frame} config={config} builtMass={null} beforeId="water" onDiagnostics={diagnostics} />);
    const mask = { ...config, sub: 2, weights: new Float32Array(16).fill(1) };
    rerender(<RasterHeatmap frame={frame} config={config} builtMass={mask} beforeId="water" onDiagnostics={diagnostics} />);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instances[1].postMessage).toHaveBeenLastCalledWith({ type: 'render', id: 1, cells: frame.cells });
    rerender(<RasterHeatmap frame={null} config={{ ...config }} builtMass={null} beforeId="water" onDiagnostics={diagnostics} />);
    expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledTimes(1);
  });

  it('tolerates map teardown before the React child is unmounted', () => {
    const { unmount } = render(<RasterHeatmap frame={frame} config={config} builtMass={null} beforeId="water" onDiagnostics={diagnostics} />);
    state.map.getStyle.mockReturnValue(undefined);
    state.sources.clear();
    state.layers.delete('foot-traffic-heatmap');
    expect(() => unmount()).not.toThrow();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    state.map.getStyle.mockReturnValue({});
  });

  it('shows the retained frame when mounted again and recovers style resources', () => {
    const first = render(<RasterHeatmap frame={frame} config={config} builtMass={null} beforeId="water" onDiagnostics={diagnostics} />);
    first.unmount();
    render(<RasterHeatmap frame={frame} config={config} builtMass={null} beforeId="water" onDiagnostics={diagnostics} />);
    expect(FakeWorker.instances[1].postMessage).toHaveBeenLastCalledWith({ type: 'render', id: 1, cells: frame.cells });
    state.sources.clear();
    state.layers.delete('foot-traffic-heatmap');
    act(() => state.listeners.get('styledata')?.forEach(callback => callback()));
    expect(state.sources.has('heatmap-raster')).toBe(true);
    expect(state.layers.has('foot-traffic-heatmap')).toBe(true);
  });
});

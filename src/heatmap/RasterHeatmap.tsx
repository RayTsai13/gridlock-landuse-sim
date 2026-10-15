import { useEffect, useRef } from 'react';
import { useMap } from 'react-map-gl/maplibre';
import type { CanvasSource } from 'maplibre-gl';
import type { Frame, GridConfig } from './grid.ts';
import type { BuiltMass } from './mask.ts';
import { HEATMAP_LAYER_ID, heatmapLayer } from './layer.ts';
import { RasterQueue } from './rasterQueue.ts';

export type RasterDiagnostics = { width: number; height: number; generationMs: number; error?: string };
type Props = {
  frame: Frame | null;
  config: GridConfig | null;
  builtMass: BuiltMass | null;
  beforeId: string;
  onDiagnostics: (diagnostics: RasterDiagnostics) => void;
};

const SOURCE_ID = 'heatmap-raster';

export function RasterHeatmap({ frame, config, builtMass, beforeId, onDiagnostics }: Props) {
  const { current } = useMap();
  const queue = useRef<RasterQueue | null>(null);
  const clear = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!current || !config) return;
    const map = current.getMap();
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(2048, config.cols * 8);
    canvas.height = Math.min(2048, config.rows * 8);
    const context = canvas.getContext('2d');
    if (!context) return;
    const { west, east, north, south } = config.bounds;
    let dirty = true;
    const install = () => {
      if (!map.getStyle()) return;
      if (!map.getLayer(beforeId)) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, { type: 'canvas', canvas, animate: false,
          coordinates: [[west, north], [east, north], [east, south], [west, south]] });
        dirty = true;
      }
      if (!map.getLayer(HEATMAP_LAYER_ID)) map.addLayer({ ...heatmapLayer, source: SOURCE_ID }, beforeId);
    };
    const upload = () => {
      if (!dirty || !map.getStyle()) return;
      const source = map.getSource(SOURCE_ID) as CanvasSource | undefined;
      if (!source || !map.isSourceLoaded(SOURCE_ID)) return;
      const view = map.getBounds();
      if (view.getEast() < west || view.getWest() > east || view.getNorth() < south || view.getSouth() > north) return;
      source.play();
      source.pause();
      dirty = false;
    };
    const reset = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      dirty = true;
      map.triggerRepaint();
      onDiagnostics({ width: canvas.width, height: canvas.height, generationMs: 0 });
    };
    const worker = new Worker(new URL('./raster.worker.ts', import.meta.url), { type: 'module' });
    const scheduler = new RasterQueue(worker, { type: 'init', config, mask: builtMass }, result => {
      context.putImageData(new ImageData(result.pixels as Uint8ClampedArray<ArrayBuffer>, result.width, result.height), 0, 0);
      dirty = true;
      map.triggerRepaint();
      onDiagnostics({ width: result.width, height: result.height, generationMs: result.generationMs });
    }, () => {
      reset();
      onDiagnostics({ width: canvas.width, height: canvas.height, generationMs: 0, error: 'Heatmap rendering failed. Toggle the heatmap to retry.' });
    });
    queue.current = scheduler;
    clear.current = reset;
    map.on('styledata', install);
    map.on('render', upload);
    install();
    return () => {
      scheduler.dispose();
      queue.current = null;
      clear.current = null;
      map.off('styledata', install);
      map.off('render', upload);
      if (!map.getStyle()) return;
      if (map.getLayer(HEATMAP_LAYER_ID)) map.removeLayer(HEATMAP_LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [current, config, builtMass, beforeId, onDiagnostics]);

  useEffect(() => {
    if (frame) queue.current?.submit(frame.cells);
    else {
      queue.current?.invalidate();
      clear.current?.();
    }
  }, [frame, config, builtMass]);

  return null;
}

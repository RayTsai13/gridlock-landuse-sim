import { HEATMAP_SUBDIVISIONS, visitFrameSamples } from './grid.ts';
import type { CellTuple, GridConfig } from './grid.ts';
import type { BuiltMass } from './mask.ts';

export const SMOOTHING_METERS = 80;
const METERS_PER_DEGREE = 111_320;
const COLOR_STOPS = [
  [0, 0, 0, 0, 0], [0.1, 49, 54, 149, 0], [0.18, 69, 117, 180, 0.30],
  [0.28, 116, 173, 209, 0.45], [0.38, 171, 217, 233, 0.55],
  [0.48, 224, 243, 248, 0.62], [0.56, 255, 255, 191, 0.70],
  [0.64, 254, 224, 144, 0.74], [0.72, 253, 174, 97, 0.78],
  [0.8, 244, 109, 67, 0.80], [0.9, 215, 48, 39, 0.83], [1, 165, 0, 38, 0.86],
];

export function densityColor(density: number): number[] {
  const value = Math.max(0, Math.min(1, density));
  const upper = COLOR_STOPS.findIndex(stop => stop[0] >= value);
  const right = COLOR_STOPS[Math.max(1, upper)];
  const left = COLOR_STOPS[Math.max(0, upper - 1)];
  const fraction = (value - left[0]) / (right[0] - left[0]);
  return [1, 2, 3, 4].map(channel => Math.round(
    (left[channel] + (right[channel] - left[channel]) * fraction) * (channel === 4 ? 255 : 1),
  ));
}

const palette = Uint8ClampedArray.from(Array.from({ length: 4097 }, (_, index) => densityColor(index / 4096)).flat());

function kernel(sigma: number) {
  const radius = Math.ceil(sigma * 3);
  const weights = Float64Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-0.5 * ((index - radius) / sigma) ** 2));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map(value => value / total);
}

export function smoothField(values: Float32Array, width: number, height: number, sigmaX: number, sigmaY: number): Float32Array {
  const horizontal = new Float32Array(values.length);
  const output = new Float32Array(values.length);
  for (const [weights, source, target, stride, limit] of [
    [kernel(sigmaX), values, horizontal, 1, width],
    [kernel(sigmaY), horizontal, output, width, height],
  ] as const) {
    const radius = (weights.length - 1) / 2;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const index = row * width + col;
        const position = stride === 1 ? col : row;
        let total = 0;
        for (let offset = -radius; offset <= radius; offset++) {
          if (position + offset >= 0 && position + offset < limit) total += source[index + offset * stride] * weights[offset + radius];
        }
        target[index] = total;
      }
    }
  }
  return output;
}

export function mercatorLatitude(latitude: number) {
  return Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
}

export function rasterLatitude(config: GridConfig, row: number, height: number) {
  const north = mercatorLatitude(config.bounds.north);
  const south = mercatorLatitude(config.bounds.south);
  return (2 * Math.atan(Math.exp(north + (south - north) * (row + 0.5) / height)) - Math.PI / 2) * 180 / Math.PI;
}

export function createRasterizer(config: GridConfig, mask: BuiltMass | null) {
  const sampleWidth = config.cols * HEATMAP_SUBDIVISIONS;
  const sampleHeight = config.rows * HEATMAP_SUBDIVISIONS;
  const width = Math.min(2048, config.cols * 8);
  const height = Math.min(2048, config.rows * 8);
  const { bounds } = config;
  const spacingY = (bounds.north - bounds.south) * METERS_PER_DEGREE / sampleHeight;
  const spacingX = (bounds.east - bounds.west) * METERS_PER_DEGREE * Math.cos((bounds.north + bounds.south) * Math.PI / 360) / sampleWidth;
  const columns = Float64Array.from({ length: width }, (_, col) => (col + 0.5) * sampleWidth / width - 0.5);
  const rows = Float64Array.from({ length: height }, (_, row) =>
    (bounds.north - rasterLatitude(config, row, height)) / (bounds.north - bounds.south) * sampleHeight - 0.5);

  return (cells: CellTuple[]) => {
    const started = performance.now();
    const samples = new Float32Array(sampleWidth * sampleHeight);
    visitFrameSamples(cells, config, mask, (row, col, density) => { samples[row * sampleWidth + col] = density; });
    const field = smoothField(samples, sampleWidth, sampleHeight, SMOOTHING_METERS / spacingX, SMOOTHING_METERS / spacingY);
    const pixels = new Uint8ClampedArray(width * height * 4);
    const read = (row: number, col: number) => row >= 0 && row < sampleHeight && col >= 0 && col < sampleWidth ? field[row * sampleWidth + col] : 0;
    for (let row = 0; row < height; row++) {
      const top = Math.floor(rows[row]);
      const vertical = rows[row] - top;
      for (let col = 0; col < width; col++) {
        const left = Math.floor(columns[col]);
        const horizontal = columns[col] - left;
        const upper = read(top, left) * (1 - horizontal) + read(top, left + 1) * horizontal;
        const lower = read(top + 1, left) * (1 - horizontal) + read(top + 1, left + 1) * horizontal;
        const density = upper * (1 - vertical) + lower * vertical;
        const color = Math.round(Math.min(1, Math.max(0, density)) * 4096) * 4;
        const index = (row * width + col) * 4;
        pixels[index] = palette[color];
        pixels[index + 1] = palette[color + 1];
        pixels[index + 2] = palette[color + 2];
        pixels[index + 3] = palette[color + 3];
      }
    }
    return { width, height, pixels, generationMs: performance.now() - started };
  };
}

export type RasterResult = ReturnType<ReturnType<typeof createRasterizer>>;
export type RasterRequest = { type: 'init'; config: GridConfig; mask: BuiltMass | null } | { type: 'render'; id: number; cells: CellTuple[] };
export type RasterResponse = RasterResult & { id: number };

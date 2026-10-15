import type { FeatureCollection, Point } from 'geojson';
import type { BuiltMass } from './mask.ts';

export type Bounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type GridConfig = {
  bounds: Bounds;
  rows: number;
  cols: number;
};

/** [row, col, density] tuple from the SSE frame */
export type CellTuple = [row: number, col: number, density: number];

export type CellMetrics = [row: number, col: number, generated: number, served: number, unmet: number];

export type ModelInfo = {
  synthetic: boolean;
  sourceFeedEndDate?: string;
  sourceFeedVersion?: string;
  effectiveTripsPerDeparture?: number;
  walkRadiusMeters?: number;
};

export type Frame = {
  cell_metrics?: CellMetrics[];
  totals?: { generated: number; served: number; unmet: number };
  model?: ModelInfo;
  timestamp: number;
  state_version?: string;
  sim_time?: SimTime;
  cells: CellTuple[];
};

export type SimTime = {
  day_of_week: number;
  time_bin: number;
  minute_of_week: number;
};

const HEATMAP_SUBDIVISIONS = 2;

// Above the backend's own DISPLAY_THRESHOLD, so bilinear interpolation cannot
// resurrect cells the server deliberately culled. Set lower and the tail of
// barely-there samples arrives as a wash of haze over the whole viewport.
const MIN_RENDER_DENSITY = 0.02;

// How hard the built-mass field redistributes a cell's density across its
// subcells. 1.0 concentrates all of it on the densest block; 0.0 disables the
// shaping. Empty subcells are zero at any exponent above 0.
const BUILT_MASS_SHAPING = 0.5;

const coordinateCache = new WeakMap<GridConfig, number[][]>();

function coordinatesFor(config: GridConfig) {
  const cached = coordinateCache.get(config);
  if (cached) return cached;
  const coordinates: number[][] = [];
  coordinateCache.set(config, coordinates);
  return coordinates;
}

const shapingCache = new WeakMap<BuiltMass, { weights: Float64Array; means: Float64Array }>();

function shapingFor(mask: BuiltMass) {
  const cached = shapingCache.get(mask);
  if (cached) return cached;
  const weights = Float64Array.from(mask.weights, weight => weight ** BUILT_MASS_SHAPING);
  const means = new Float64Array(mask.rows * mask.cols);
  const subCols = mask.cols * mask.sub;
  for (let row = 0; row < mask.rows; row++) {
    for (let col = 0; col < mask.cols; col++) {
      let total = 0;
      for (let subRow = 0; subRow < mask.sub; subRow++) {
        const start = (row * mask.sub + subRow) * subCols + col * mask.sub;
        for (let subCol = 0; subCol < mask.sub; subCol++) total += weights[start + subCol];
      }
      means[row * mask.cols + col] = total / (mask.sub * mask.sub);
    }
  }
  const shaping = { weights, means };
  shapingCache.set(mask, shaping);
  return shaping;
}

export function frameToGeoJSON(
  cells: CellTuple[],
  config: GridConfig,
  builtMass?: BuiltMass | null,
): FeatureCollection<Point> {
  const { bounds, rows, cols } = config;
  const coordinates = coordinatesFor(config);
  const cellWidth = (bounds.east - bounds.west) / cols;
  const cellHeight = (bounds.north - bounds.south) / rows;
  const values = new Float32Array(rows * cols);

  for (const [row, col, density] of cells) {
    if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
    values[row * cols + col] = density;
  }

  // The mask is authored against the grid it was built for. A stale artifact
  // would silently mis-place every weight, so ignore it rather than guess.
  const mask =
    builtMass && builtMass.rows === rows && builtMass.cols === cols &&
    (Object.keys(bounds) as (keyof Bounds)[]).every(key => Math.abs(builtMass.bounds[key] - bounds[key]) < 1e-9) ? builtMass : null;

  const shaping = mask ? shapingFor(mask) : null;
  const features: FeatureCollection<Point>['features'] = [];

  // Frames are sparse, but every sample of a cell reads its 8-neighbourhood
  // (the subdivision offsets span +/- half a cell), so a cell can only produce
  // output if something within one step of it is non-zero. Visiting just that
  // dilated set keeps the cost proportional to the active area rather than to
  // the whole grid -- the difference between a few hundred cells and every one
  // of them, every second.
  const visited: number[] = [];
  const marked = new Uint8Array(rows * cols);
  for (const [row, col] of cells) {
    if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
    const rowStart = Math.max(0, row - 1);
    const rowEnd = Math.min(rows - 1, row + 1);
    const colStart = Math.max(0, col - 1);
    const colEnd = Math.min(cols - 1, col + 1);
    for (let r = rowStart; r <= rowEnd; r++) {
      for (let c = colStart; c <= colEnd; c++) {
        const index = r * cols + c;
        if (!marked[index]) {
          marked[index] = 1;
          visited.push(index);
        }
      }
    }
  }

  for (const index of visited) {
    const row = Math.floor(index / cols);
    const col = index % cols;

    // Shaping is mean-preserving: a cell keeps the brightness the server gave
    // it, but spends it on the blocks that actually hold buildings. A cell with
    // no built mass at all -- open water, the middle of a park -- spends none.
    let shapingScale = 0;
    if (mask) {
      const meanWeight = shaping!.means[index];
      if (meanWeight <= 0) continue;
      shapingScale = 1 / meanWeight;
    }

    for (let sampleY = 0; sampleY < HEATMAP_SUBDIVISIONS; sampleY++) {
      const y = (sampleY + 0.5) / HEATMAP_SUBDIVISIONS;
      const rowCoord = row + y - 0.5;

      for (let sampleX = 0; sampleX < HEATMAP_SUBDIVISIONS; sampleX++) {
        const x = (sampleX + 0.5) / HEATMAP_SUBDIVISIONS;
        const colCoord = col + x - 0.5;
        let density = sampleGrid(values, rows, cols, rowCoord, colCoord);

        if (mask) {
          density = Math.min(
            1,
            density * subcellWeight(mask, shaping!.weights, row + y, col + x) * shapingScale,
          );
        }

        if (density <= MIN_RENDER_DENSITY) continue;

        const sampleIndex = index * HEATMAP_SUBDIVISIONS ** 2 + sampleY * HEATMAP_SUBDIVISIONS + sampleX;
        const position = coordinates[sampleIndex] ??= [
          bounds.west + (col + x) * cellWidth,
          bounds.north - (row + y) * cellHeight,
        ];

        features.push({
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: position,
          },
          properties: { density },
        });
      }
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

export function emptyGrid(): FeatureCollection<Point> {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Shaped built-mass weight at a point given in cell units, where `rowCoord` and
 * `colCoord` are measured from the grid's north-west corner (so integers land
 * on cell corners, matching the geographic mapping above).
 */
function subcellWeight(mask: BuiltMass, weights: Float64Array, rowCoord: number, colCoord: number): number {
  const { sub, cols } = mask;
  const subRow = Math.min(mask.rows * sub - 1, Math.floor(rowCoord * sub));
  const subCol = Math.min(cols * sub - 1, Math.floor(colCoord * sub));
  return weights[subRow * cols * sub + subCol];
}

function sampleGrid(
  values: Float32Array,
  rows: number,
  cols: number,
  rowCoord: number,
  colCoord: number,
): number {
  const row0 = Math.floor(rowCoord);
  const col0 = Math.floor(colCoord);
  const rowT = clamp01(rowCoord - row0);
  const colT = clamp01(colCoord - col0);

  // Outside the grid reads as zero rather than repeating the edge value:
  // clamping smears the field half a cell past the boundary, which is exactly
  // the leak that carried shoreline density out over the water.
  const topLeft = valueAt(values, rows, cols, row0, col0);
  const topRight = valueAt(values, rows, cols, row0, col0 + 1);
  const bottomLeft = valueAt(values, rows, cols, row0 + 1, col0);
  const bottomRight = valueAt(values, rows, cols, row0 + 1, col0 + 1);
  const top = topLeft * (1 - colT) + topRight * colT;
  const bottom = bottomLeft * (1 - colT) + bottomRight * colT;
  return top * (1 - rowT) + bottom * rowT;
}

function valueAt(
  values: Float32Array,
  rows: number,
  cols: number,
  row: number,
  col: number,
): number {
  if (row < 0 || row >= rows || col < 0 || col >= cols) return 0;
  return values[row * cols + col];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

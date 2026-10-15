import { describe, expect, it } from 'vitest';
import { frameToGeoJSON, emptyGrid } from '../grid.ts';
import type { CellTuple, GridConfig } from '../grid.ts';
import type { BuiltMass } from '../mask.ts';

const config: GridConfig = {
  bounds: { west: -122.5, south: 47.5, east: -122.4, north: 47.6 },
  rows: 10,
  cols: 10,
};

const cellWidth = (config.bounds.east - config.bounds.west) / config.cols;
const cellHeight = (config.bounds.north - config.bounds.south) / config.rows;

const SUB = 2;

/** A built-mass field whose every subcell carries `weight`. */
function uniformMass(weight: number, cfg: GridConfig = config): BuiltMass {
  return {
    bounds: cfg.bounds,
    rows: cfg.rows,
    cols: cfg.cols,
    sub: SUB,
    weights: new Float32Array(cfg.rows * cfg.cols * SUB * SUB).fill(weight),
  };
}

function setSubcell(mask: BuiltMass, subRow: number, subCol: number, weight: number) {
  mask.weights[subRow * mask.cols * mask.sub + subCol] = weight;
}

describe('frameToGeoJSON', () => {
  it('returns an empty collection for an empty frame', () => {
    expect(frameToGeoJSON([], config).features).toHaveLength(0);
  });

  it('places samples inside the cell they belong to', () => {
    const cells: CellTuple[] = [[5, 5, 1]];
    const { features } = frameToGeoJSON(cells, config);
    expect(features.length).toBeGreaterThan(0);

    // Every emitted point must fall within one cell of the hot cell's centre.
    const centreLon = config.bounds.west + (5 + 0.5) * cellWidth;
    const centreLat = config.bounds.north - (5 + 0.5) * cellHeight;
    for (const feature of features) {
      const [lon, lat] = feature.geometry.coordinates;
      expect(Math.abs(lon - centreLon)).toBeLessThanOrEqual(cellWidth * 1.5);
      expect(Math.abs(lat - centreLat)).toBeLessThanOrEqual(cellHeight * 1.5);
    }
  });

  it('never emits a density above the source value', () => {
    const { features } = frameToGeoJSON([[4, 4, 0.8]], config);
    for (const feature of features) {
      const density = feature.properties?.density as number;
      expect(density).toBeGreaterThan(0);
      expect(density).toBeLessThanOrEqual(0.8 + 1e-6);
    }
  });

  it('ignores cells outside the configured grid', () => {
    const cells: CellTuple[] = [
      [-1, 0, 1],
      [0, 99, 1],
      [999, 999, 1],
    ];
    expect(frameToGeoJSON(cells, config).features).toHaveLength(0);
  });

  it('produces the same output whether or not the whole grid is scanned', () => {
    // The conversion only visits cells within one step of a non-zero value.
    // That optimisation must not change the result, so compare against a
    // reference that rasterises every cell of the frame explicitly.
    const cells: CellTuple[] = [
      [2, 3, 0.9],
      [7, 8, 0.4],
      [0, 0, 0.55],
      [9, 9, 0.7],
    ];
    const sparse = frameToGeoJSON(cells, config);

    const everyCell: CellTuple[] = [];
    for (let row = 0; row < config.rows; row++) {
      for (let col = 0; col < config.cols; col++) {
        const match = cells.find(([r, c]) => r === row && c === col);
        everyCell.push([row, col, match ? match[2] : 0]);
      }
    }
    const dense = frameToGeoJSON(everyCell, config);

    const key = (f: (typeof sparse.features)[number]) =>
      `${f.geometry.coordinates[0].toFixed(9)},${f.geometry.coordinates[1].toFixed(9)},${
        (f.properties?.density as number).toFixed(6)
      }`;
    expect(new Set(sparse.features.map(key))).toEqual(
      new Set(dense.features.map(key)),
    );
  });

  it('scales work with the active area, not the grid size', () => {
    const bigConfig: GridConfig = { ...config, rows: 200, cols: 200 };
    const before = performance.now();
    const { features } = frameToGeoJSON([[100, 100, 1]], bigConfig);
    const elapsed = performance.now() - before;

    // One hot cell in a 40,000-cell grid touches at most 9 cells x 16 samples.
    expect(features.length).toBeLessThanOrEqual(9 * SUB * SUB);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('frameToGeoJSON built-mass shaping', () => {
  it('renders unshaped when no mask is supplied', () => {
    const cells: CellTuple[] = [[5, 5, 1]];
    const withoutMask = frameToGeoJSON(cells, config);
    const withNull = frameToGeoJSON(cells, config, null);
    expect(withNull.features).toEqual(withoutMask.features);
  });

  it('leaves a uniformly built cell alone', () => {
    // Shaping is mean-preserving, so a cell whose subcells all carry the same
    // weight must come out exactly as it went in, whatever that weight is.
    const cells: CellTuple[] = [[5, 5, 1]];
    const unshaped = frameToGeoJSON(cells, config);
    for (const weight of [0.2, 0.5, 1]) {
      const shaped = frameToGeoJSON(cells, config, uniformMass(weight));
      expect(shaped.features).toHaveLength(unshaped.features.length);
      shaped.features.forEach((feature, index) => {
        expect(feature.properties?.density as number).toBeCloseTo(
          unshaped.features[index].properties?.density as number,
          6,
        );
      });
    }
  });

  it('emits nothing where there is no built mass', () => {
    const mask = uniformMass(0);
    expect(frameToGeoJSON([[5, 5, 1]], config, mask).features).toHaveLength(0);
  });

  it('moves a cell\'s density onto the subcells that hold buildings', () => {
    // Only the north-west subcell of cell (5, 5) has any built mass, so that is
    // the only place inside the cell heat may appear.
    const mask = uniformMass(0);
    setSubcell(mask, 5 * SUB, 5 * SUB, 1);

    const { features } = frameToGeoJSON([[5, 5, 1]], config, mask);
    expect(features).toHaveLength(1);

    const [lon, lat] = features[0].geometry.coordinates;
    expect(lon).toBeCloseTo(config.bounds.west + (5 + 0.5 / SUB) * cellWidth, 9);
    expect(lat).toBeCloseTo(config.bounds.north - (5 + 0.5 / SUB) * cellHeight, 9);
  });

  it('ignores a mask built for a different grid', () => {
    const stale = uniformMass(0, { ...config, rows: 12, cols: 12 });
    const cells: CellTuple[] = [[5, 5, 1]];
    // A zeroed mask would erase everything if it were applied; a mismatched one
    // must be dropped instead, because its weights index the wrong cells.
    expect(frameToGeoJSON(cells, config, stale).features).toEqual(
      frameToGeoJSON(cells, config).features,
    );
  });
});

describe('emptyGrid', () => {
  it('is a valid empty FeatureCollection', () => {
    expect(emptyGrid()).toEqual({ type: 'FeatureCollection', features: [] });
  });
});

it('ignores a mask with shifted geographic bounds', () => {
  const mask = uniformMass(0);
  mask.bounds = { ...config.bounds, west: config.bounds.west + 0.01 };
  expect(frameToGeoJSON([[5, 5, 1]], config, mask)).toEqual(frameToGeoJSON([[5, 5, 1]], config));
});

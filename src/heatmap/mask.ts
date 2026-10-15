import type { Bounds } from './grid.ts';
import { useEffect, useState } from 'react';

/**
 * Per-subcell "how much city is actually here" weights, in [0, 1].
 *
 * Built offline by `seattle/scripts/build_heatmap_built_mass.py` from Seattle's
 * building footprints, at `sub` times the heatmap grid's resolution (~125 m at
 * sub = 2). The backend reads the same artifact to shape demand; the frontend
 * uses it to decide *where inside a cell* that demand should show, which is what
 * keeps heat off Elliott Bay and out of Discovery Park.
 *
 * Row-major, row 0 is the north edge -- the same convention as the SSE frame
 * and the scalar raster field.
 */
export type BuiltMass = {
  bounds: Bounds;
  rows: number;
  cols: number;
  sub: number;
  weights: Float32Array;
};

const BUILT_MASS_URL = '/seattle/seattle-built-mass.json?grid=112x70';

type BuiltMassPayload = {
  bounds: Bounds;
  rows: number;
  cols: number;
  sub: number;
  weights: number[];
};

export function parseBuiltMass(payload: BuiltMassPayload): BuiltMass {
  const { rows, cols, sub } = payload;
  const expected = rows * cols * sub * sub;
  if (!payload.bounds || !(['west', 'south', 'east', 'north'] as const).every(key => Number.isFinite(payload.bounds[key])) ||
      ![rows, cols, sub].every(value => Number.isInteger(value) && value > 0) || payload.weights.length !== expected) {
    throw new Error(
      `Built-mass holds ${payload.weights.length} weights, expected ${expected}`,
    );
  }
  return { bounds: payload.bounds, rows, cols, sub, weights: Float32Array.from(payload.weights) };
}

/**
 * Fetch the built-mass field once.
 *
 * Returns `null` until it arrives, and stays `null` if the fetch fails --
 * The renderer operates unshaped in that case rather than showing nothing.
 */
export function useBuiltMass(): BuiltMass | null {
  const [builtMass, setBuiltMass] = useState<BuiltMass | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch(BUILT_MASS_URL, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return response.json() as Promise<BuiltMassPayload>;
      })
      .then((payload) => setBuiltMass(parseBuiltMass(payload)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.warn('Built-mass field unavailable; heatmap will not be shaped.', error);
      });

    return () => controller.abort();
  }, []);

  return builtMass;
}

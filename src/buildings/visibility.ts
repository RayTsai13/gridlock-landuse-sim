export type Bounds = { west: number; south: number; east: number; north: number };

export function intersectsBounds(a: Bounds, b: Bounds) {
  return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
}

// Keep only the current view and its caller-supplied margin, plus startup's
// initial source until it reports ready. No history accumulates while panning.
export function visibleBuildingRegions<T extends { id: string; bounds: Bounds }>(
  regions: T[], bounds: Bounds, initialReady: boolean,
): T[] {
  return regions.filter((region, index) =>
    intersectsBounds(region.bounds, bounds) || (!initialReady && index === 0));
}

import { describe, expect, it } from 'vitest';
import { visibleBuildingRegions } from './visibility.ts';

const downtown = { id: 'downtown', bounds: { west: 0, east: 1, south: 0, north: 1 } };
const west = { id: 'west', bounds: { west: -2, east: -1, south: 0, north: 1 } };
const north = { id: 'north', bounds: { west: 0, east: 1, south: 3, north: 4 } };
const regions = [downtown, west, north];

describe('building source selection', () => {
  it('loads the view without prefetching every region and releases old views', () => {
    expect(visibleBuildingRegions(regions, downtown.bounds, true)).toEqual([downtown]);
    expect(visibleBuildingRegions(regions, west.bounds, true)).toEqual([west]);
    expect(visibleBuildingRegions(regions, north.bounds, true)).toEqual([north]);
  });
  it('keeps startup readiness possible if the user pans before the initial load', () => {
    expect(visibleBuildingRegions(regions, west.bounds, false)).toEqual([downtown, west]);
  });
  it('retains all intersecting regions at wider zooms', () => {
    expect(visibleBuildingRegions(regions, {west: -2, east: 1, south: 0, north: 4}, true)).toEqual(regions);
  });
});

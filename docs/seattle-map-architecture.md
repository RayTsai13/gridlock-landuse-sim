# Seattle Map Architecture

This document describes the current Seattle building map path in the frontend.

For the SSE heatmap overlay, see:
- [frontend-heatmap.md](./frontend-heatmap.md)
- [heatmap-api-contract.md](./heatmap-api-contract.md)

## Current Runtime Model

The frontend does **not** query ArcGIS building services at runtime anymore.

Instead, it:

1. starts on a downtown Seattle camera
2. loads cached local GeoJSON region files from `public/seattle/`
3. selects only regions intersecting the padded viewport, with one URL-backed source per region
4. renders those footprints as MapLibre `fill-extrusion`
5. overlays the SSE heatmap source above the buildings

The runtime entry point is [src/App.tsx](../src/App.tsx).

## Region Coverage

The current cached building regions are:

- `Downtown Core`
- `East Neighborhoods`
- `Northwest Seattle`
- `Beacon Hill`
- `West Seattle`

Together, those cover the current project area:

- downtown / Belltown / South Lake Union
- Beacon Hill
- West Seattle
- east of downtown through Madison Valley, Madrona, Leschi, Denny-Blaine, and Washington Park
- north through Queen Anne, Magnolia, Fremont, Wallingford, Phinney Ridge, Ballard, Madison Park, and the University District

## Startup Behavior

The app is intentionally downtown-first.

Initial view:

- longitude `-122.3337`
- latitude `47.6074`
- zoom `15.3`
- pitch `55`
- bearing `-18`

Downtown remains selected until its first source-load event. Other sources are selected
only when they intersect the current viewport plus a 20% margin. MapLibre fetches their
URLs directly in its worker; App does not retain parsed GeoJSON objects. Panning removes
offscreen sources, and returning can reuse the browser HTTP cache. At citywide zooms all
intersecting regions are deliberately visible; vector tiles remain a possible later step.

Train animation lives in the deferred `MapOverlays.tsx` subtree, so animation frames do
not rerender the map controls. The landmark code/model loads only when its coordinates
enter the padded viewport. Its runtime asset is `space-needle.optimized.glb` (2048px
WebP texture); the original GLB remains available offline for regeneration.

Run `npm run optimize:landmark` after changing the source model. `npm run build` checks
landmark and entry-JavaScript size budgets and excludes legacy unused public assets from
the production output. The optimization script preserves mesh buffers and materials;
the installed glTF loader supports the required `EXT_texture_webp` extension.

## Data Sources

The frontend uses locally cached exports, but the cached files come from official Seattle data:

- 2D footprints: City of Seattle `Building_Outlines_2023`
- 3D height attributes: City of Seattle `Seattle_BuildingShells`

Those official sources are used **offline** during preprocessing, not during page load.

## Offline Pipeline

The Seattle building pipeline lives under [`seattle/scripts/`](../seattle/scripts).

Main steps:

1. `extract_seattle_building_heights.py`
   - walks the official `Seattle_BuildingShells` scene layer
   - extracts `BLDGHEIGHT` / `EAVEHEIGHT`
   - derives per-building scene centroids
2. `join_seattle_building_heights.py`
   - matches extracted scene rows onto official `Building_Outlines_2023` footprints
3. `export_seattle_building_regions.py`
   - exports cached neighborhood GeoJSON chunks into `public/seattle/`

There is also `export_seattle_building_height_lookup.py`, but that compact lookup is no longer the main runtime path. The current frontend reads the pre-joined region GeoJSON files directly.

## Runtime Assets

Current main runtime assets:

- `public/seattle/seattle-buildings-downtown-core.geojson`
- `public/seattle/seattle-buildings-east-neighborhoods.geojson`
- `public/seattle/seattle-buildings-northwest-seattle.geojson`
- `public/seattle/seattle-buildings-west-seattle.geojson`
- `public/seattle/seattle-buildings-beacon-hill.geojson`

Auxiliary asset:

- `public/seattle/seattle-building-regions-summary.json`

Legacy/supporting asset:

- `public/seattle/seattle-building-heights.json`

## Why This Design

This setup is a compromise between correctness and frontend performance.

- `ArcGIS SceneView` rendered official 3D shells more directly, but was too heavy for the current app
- live `FeatureServer` footprint queries were accurate, but slow and inconsistent on load
- local cached region GeoJSON keeps building locations correct while avoiding runtime dependency on city services

For the current project phase, accurate building placement matters more than perfectly faithful live 3D building models.

# Seattle Reference

This folder is the Seattle-specific workspace for the project.

For the frontend/runtime map architecture, see [docs/seattle-map-architecture.md](../docs/seattle-map-architecture.md).

## Running the scripts

Run Seattle scripts from the repository root. The building-height and region scripts use the Python standard library; `build_seattle_station_vectors.py` also needs the packages in `data_processing/requirements.txt`.

```bash
python3 seattle/scripts/extract_seattle_building_heights.py
python3 seattle/scripts/join_seattle_building_heights.py
python3 seattle/scripts/export_seattle_building_regions.py
```

These commands make network requests and overwrite checked-in generated artifacts after successful fetch/processing. Review file sizes, generated summaries, and the git diff before committing regenerated data. Each script supports `--help` and optional limits useful for smaller validation runs.

## Layout

- `scripts/` (all build-time only; the backend imports none of them)
  - `build_seattle_station_vectors.py`
    - Builds Seattle station activity vectors from GTFS and Census inputs.
  - `extract_seattle_building_heights.py`
    - Extracts official building height attributes from Seattle's `Seattle_BuildingShells` SceneServer.
  - `join_seattle_building_heights.py`
    - Joins extracted scene-layer heights onto official `Building_Outlines_2023` footprints.
  - `export_seattle_building_height_lookup.py`
    - Exports a compact footprint-height lookup for frontend use.
    - Useful for debugging or alternate export paths, but not the main current runtime path.
  - `export_seattle_building_regions.py`
    - Exports cached Seattle neighborhood GeoJSON chunks for the map.
  - `fetch_seattle_buildings.py`
    - Legacy OSM footprint fetcher for quick local extracts.

- `data/raw/`
  - Seattle-only raw inputs that were moved out of `data_processing`.

- `data/processed/`
  - Seattle-only generated artifacts:
    - `seattle_scene_heights.csv`
    - `seattle_building_height_join.csv`
    - `seattle_heatmap_features.csv`
    - `seattle_heatmap_grid.geojson` — **the only file the backend reads at
      runtime**, and only for grid bounds / rows / cols
    - related summary files

## Frontend Assets

The Seattle map assets are served from `public/seattle/`.

Current cached building region files:

- `public/seattle/seattle-buildings-downtown-core.geojson`
- `public/seattle/seattle-buildings-east-neighborhoods.geojson`
- `public/seattle/seattle-buildings-northwest-seattle.geojson`
- `public/seattle/seattle-buildings-west-seattle.geojson`
- `public/seattle/seattle-buildings-beacon-hill.geojson`

Other related frontend assets:

- `public/seattle/seattle-building-heights.json`
  - supporting/legacy height lookup; current frontend mainly uses pre-joined region GeoJSON
- `public/seattle/seattle-building-regions-summary.json`

## Typical Flow

The building pipeline is the one that still matters day to day:

1. Run `extract_seattle_building_heights.py`
2. Run `join_seattle_building_heights.py`
3. Run `export_seattle_building_regions.py`
4. The frontend loads the cached region GeoJSON files from `public/seattle/`

The concrete root-level commands are:

```bash
python3 seattle/scripts/extract_seattle_building_heights.py
python3 seattle/scripts/join_seattle_building_heights.py
python3 seattle/scripts/export_seattle_building_regions.py
```

The heatmap dataset builder moved to `data_processing/`
(`src/pipelines/seattle/build_heatmap_dataset.py`). The model-training stage
that once followed it has been removed: the backend generates demand
analytically from the land-use model in `backend/landuse.py`.

## Current Frontend Behavior

- Startup camera is centered on downtown Seattle.
- Buildings load from local cached files only.
- Runtime load order is:
  1. `Downtown Core`
  2. `East Neighborhoods`
  3. `Northwest Seattle`
  4. `Beacon Hill`
  5. `West Seattle`
- The map UI shows per-region loading state so neighborhood fetch progress is visible.

## Notes

- Runtime map loading should use local cached Seattle assets, not live ArcGIS building queries.
- The Seattle scripts resolve their default output paths relative to `seattle/scripts/`.
- `fetch_seattle_buildings.py` and `public/seattle/seattle-buildings.geojson` are legacy OSM paths; the region files generated from official Seattle footprints are the active path.
- `build_seattle_station_vectors.py` predates the equivalent module under `data_processing/src/pipelines/seattle/`. Prefer the data-processing module for the maintained offline feature workflow.

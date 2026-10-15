# Backend

This directory contains the real Gridlock simulation and its FastAPI HTTP/SSE interface. It reads a Seattle grid from GeoJSON, builds an analytical land-use demand field, subtracts transit capacity, applies live crowd overlays, and streams sparse demand-pressure snapshots to the frontend.

For exact request and response shapes, see [`../docs/heatmap-api-contract.md`](../docs/heatmap-api-contract.md).

See [current session, metric, and schedule interfaces](../docs/implementation-2026-10.md). Each browser initializes `POST /api/session`; mutable state is isolated per browser session. Capacity counts scheduled departures rather than using a constant stop throughput.

## Run locally

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.txt
.venv/bin/python -m uvicorn backend.server:app --host 0.0.0.0 --port 8000
```

The frontend development server proxies `/api/*` to port 8000. Useful direct checks are:

```bash
curl http://127.0.0.1:8000/healthz
curl http://127.0.0.1:8000/api/playback
curl -N http://127.0.0.1:8000/api/heatmap/stream
```

Run the backend and mock parity suite with:

```bash
.venv/bin/python -m pytest backend/tests
```

`requirements.txt` contains runtime packages. `requirements-dev.txt` includes it and adds pytest, async-test support, and HTTP test-client support.

## Data flow

```text
grid GeoJSON
  -> per-cell land-use populations
  -> time-dependent trips/hour
  + live crowd trips/hour
  -> subtract active transit capacity
  -> fixed-scale unmet-demand density
  -> sparse SSE frame snapshot
```

The grid file supplies geometry only. The runtime does not load trained models or scores from `data_processing/`.

Districts are spread with a Gaussian, which is a circle -- and Seattle is not.
Each cell's weight is therefore also multiplied by its **built mass**: the gross
floor area standing there, baked offline by
`seattle/scripts/build_heatmap_built_mass.py`. A cell with no buildings is
uninhabitable and gets a hard zero, which is what keeps demand off Elliott Bay
and Lake Union. `State.habitability` is computed once and shared by land use,
crowd overlays, walksheds, and frame composition, so nothing can disagree about
where the city is.

## Modules

| Module | Responsibility |
| --- | --- |
| `server.py` | FastAPI app, endpoints, SSE generator, lifespan-owned frame ticker |
| `state.py` | Process-wide scenario, playback, overlays, cached frame, and change notification |
| `grid.py` | GeoJSON parsing and canonical uniform-grid bounds |
| `landuse.py` | District definitions, the built-mass field, and conserved per-cell residents/jobs/students/visitors |
| `demand.py` | Weekday/weekend trips-per-person-per-hour curves |
| `network.py` | Built-in/custom transit networks, walksheds, and service-capacity allocation |
| `overlays.py` | User-created crowd overlays and spatial/temporal decay |
| `composer.py` | Demand composition and fixed absolute density scale |
| `sim_time.py` | Weekly simulation clock, playback speed, and seeking |
| `geo.py` | Small geographic math helpers |
| `tests/` | Simulation checks plus real/mock endpoint parity tests |

## Runtime invariants

- Run one worker only. the session registry is process-local; `uvicorn --workers N` cannot share sessions.
- The lifespan ticker is the only frame producer and the only place normal playback advances. SSE connection generators are readers.
- The ticker holds the clock when no subscribers are connected.
- `State.current_frame()` is cached, so every connection sees the same snapshot for a state version.
- Frames are complete sparse snapshots, not deltas. An omitted cell has zero display density.
- Demand, service capacity, and overlays use trips/hour until `composer.py` converts unmet trips to `[0, 1]` density.
- Mutating endpoints must invalidate the cached frame and notify waiting streams.
- Keep this server, `mock/server.py`, `src/heatmap/`, and the contract tests aligned when changing the API.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HEATMAP_GEOJSON` | `seattle/data/processed/seattle_heatmap_grid_250m.geojson` | Resolved from the repository root unless explicitly overridden |
| `HEATMAP_BUILT_MASS` | `seattle/data/processed/seattle_heatmap_built_mass.json` | Also repo-root relative. If the file is missing the server still boots and falls back to the coarse hand-drawn coastline in `landuse.is_probable_water` |
| `HEATMAP_FRAME_INTERVAL` | `1.0` | Wall-clock seconds per ticker iteration |
| `HEATMAP_SIM_STEP_SECONDS` | `1800` | Simulated seconds per frame |

The grid is loaded when `backend.server` is imported, so set environment overrides before starting uvicorn or importing that module in a process.

Simulation tuning stays in code, not the environment:
`landuse.BUILT_MASS_EXPONENT` and `landuse.MIN_CELL_BUILT_MASS` shape how hard
built mass steers the spread, and `composer.MAX_UNMET_TRIPS_PER_CELL_HOUR` fixes
what a density of 1.0 means. The last is calibrated against the built-mass field
and has to move with it: concentrating people onto real floor area raises peak
unmet demand, and if the scale does not follow, downtown pins at 1.0 and crowd
drops there stop being visible.

Playback speeds are quantized to whole simulated minutes per frame because `minute_of_week` is an integer in the wire contract.

## Finer grid

The default runtime grid is `seattle_heatmap_grid_250m.geojson` (112×70). Keep the original coarse grid as regeneration input; do not pair it with the new built-mass artifact. See `../docs/grid-resolution.md` for regeneration and benchmarks.

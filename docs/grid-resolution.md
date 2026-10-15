# 250 m demand grid and tooltip-only hover

This records the grid-resolution release. Its circle-renderer measurements are historical; see [the continuous raster renderer](frontend-heatmap.md) for current rendering and performance.

The real backend now defaults to `seattle_heatmap_grid_250m.geojson`: 112 rows ×
70 columns (7,840 cells), with the same extent as the previous 56×35 runtime
grid. The original coarse GeoJSON remains regeneration input. This is finer
spatial allocation of the same model, not more accurate population source data.

## Regeneration

Run from the repository root:

```bash
.venv/bin/python seattle/scripts/refine_heatmap_grid.py
.venv/bin/python seattle/scripts/build_heatmap_built_mass.py
```

The first command subdivides the canonical runtime geometry, not the clipped
edge polygons in the historical source. The second emits matching backend and
public masks. Both use two subdivisions per new cell, keeping the 125 m sampling
lattice and all 31,360 building weights identical to the previous artifact.
Commit the finer grid and both masks together with the runtime changes.

Population totals, trip rates, schedules, capacities, walking radii, and crowd
radii are unchanged. Per-cell saturation scales by cell area relative to the
original Seattle grid: 3,600 becomes 900 unmet trips/hour. Gamma, palette, blur,
opacity, and rendered sample spacing remain unchanged. Local demand and served
totals can change because finer centers and walksheds change spatial allocation.

## Hover and compatibility

Hover is tooltip-only, labeled with approximate cell width; totals are actual
generated/served/unmet trips per hour in the smaller cell, not interpolated
point measurements. No grid outline is drawn. Leaving, hiding, moving the map,
replacing grid configuration, or resetting a session clears stale inspection.
Metric lookups are indexed once per frame. Rendering caches immutable mask
shaping and sample coordinates; replace mask/config objects rather than mutating
them in place.

SSE schemas are unchanged. Consumers must read dimensions from config rather
than hard-code them. The mock retains its synthetic geometry and protocol.
Backend and frontend reject mismatched mask alignment; the frontend falls back
to unshaped rendering. A versioned mask request avoids the old one-day browser
cache, and nginx now requires revalidation for the mask. Docker copies the finer
grid explicitly. Custom coarse grids require their own matching mask.

## Validation and measured cost

The backend benchmark uses independent State instances sharing immutable inputs,
each with a 5,000-person crowd at Monday noon. Twelve advancing one-minute frames
include composition and JSON encoding. It does not include socket transport or
production hardware. Local median aggregate tick times:

| Active sessions | Coarse | Fine |
| --- | ---: | ---: |
| 1 | 3.7 ms | 7.3 ms |
| 10 | 13.4 ms | 53.8 ms |
| 100 | 137.1 ms | 552.9 ms |

All measured ticks fit within one second; the fine-grid maximum at 100 sessions
was 573.8 ms. Uncompressed JSON frames increased from about 53 KB to 195 KB.
These are local capacity observations, not a claim that the droplet supports
100 active sessions at the same latency.

Browser profiles use Chromium 156, 1280×800, 2× CPU throttling, a 20 Mbps link,
and fixed Monday-noon paused heatmaps. The deterministic basemap fixture is used
for comparison; an additional real Carto basemap run checks shorelines. Geometry
conversion timings exclude JSON parsing, map-worker processing, and GPU drawing.
Hover latency measures mouse dispatch to tooltip DOM mutation after settling,
not end-to-end display scanout. Page heap excludes workers and GPU allocations.
Final coarse → fine measurements: median geometry conversion 0.7 → 0.6 ms,
p95 conversion 0.8 → 0.9 ms, settled p95 hover 10.8 → 9.7 ms, and startup
page heap 19.48 → 20.11 MB (about +3.2%). These pass the planned conversion,
heap, and hover budgets in this controlled run; timings vary between runs.
Reports are in `grid-resolution-performance.json`; screenshots/traces remain
under ignored `test-results/profile-*` directories.

Tests cover canonical geometry, saturation equivalence, mask alignment,
population/crowd conservation, metrics, neighboring smaller cells, reset/leave
behavior, and browser controls. Visual review covers downtown, shorelines,
zoomed-out and top-down views, without changing the underlying basemap/buildings.

## Rollout

No production change is made by these local edits. On an authorized release,
deploy backend, frontend, grid, and masks together through the existing CI and
health-checked deployment workflow. Monitor aggregate composition time and
subscriber/session counts; the saved prior images provide coordinated rollback.
Temporary sessions reset on deployment as before. HTTP/IP hosting is unchanged.

Reproduce server measurements with `.venv/bin/python scripts/profile-grid.py .`.
For a coarse baseline, pass an extracted pre-change checkout as the argument.
Browser profiling uses `scripts/profile-map.mjs`; set `PROFILE_REAL_BASEMAP=1`
for visual inspection rather than deterministic performance comparisons.

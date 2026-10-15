# Frontend heatmap

The simulation streams modeled demand on a 112×70 grid (~250 m cells). The frontend renders a continuous density field; it does not draw colored circles or increase the model's spatial accuracy. See [the wire contract](heatmap-api-contract.md) and [grid calibration](grid-resolution.md).

## Data flow

1. Initialize the private session before mounting the SSE consumer.
2. `useHeatmap` accepts configuration, scenario, playback, and frame events, retaining the latest accepted raw frame. Frames before configuration, during a pending scenario switch, or below the accepted state-version floor are discarded.
3. A visible `RasterHeatmap` sends accepted cells to a module Web Worker. Configuration and the building mask are sent once per worker lifetime.
4. The worker samples the grid at two samples per cell axis (~125 m), using the existing bilinear interpolation and mean-normalized building-mass shaping. Missing samples are zero; incompatible masks are ignored.
5. A separable Gaussian (80 m standard deviation, truncated at three standard deviations) smooths scalar density before coloring. This intentionally softens block-scale mask discontinuities without replacing the backend demand model.
6. The worker interpolates onto eight pixels per cell axis: 560×896 (~31 m visual spacing) in production. Pixel rows use inverse Web Mercator latitude, matching the map's projected ground plane.
7. A fixed palette lookup colors each pixel. Density never renormalizes to the current frame, viewport, or zoom. The palette's transparent low-density tail and overall opacity of 0.82 are retained.
8. A MapLibre canvas source and raster layer display the result with linear sampling and zero raster fade. The existing water-polygon layer clips the shoreline; transit layers remain above it.

The raster is bounded to 2048 pixels per axis. Its resolution is visual interpolation only: tooltip totals and the demand index still come from the original cell, not a raster pixel. No API, backend grid, schedule, capacity, or population changes accompany this renderer.

## Scheduling and lifecycle

There is at most one active worker render and one replaceable pending frame. Superseded results are dropped. Configuration or mask replacement terminates the old worker and regenerates from the latest accepted frame. Frame clearing and scenario/session resets clear the canvas and invalidate outstanding work. Late scenario HTTP responses from a previous configuration/session are ignored.

Hiding the heatmap unmounts the renderer, terminates its worker, and removes map resources. The stream retains the latest raw frame for showing it again. Style reloads recreate the canvas source and layer.

Canvas animation is disabled. After a changed canvas becomes visible, a play/pause pair uploads it once and requests a repaint; ordinary idle or pan frames do not continually upload textures. An offscreen pending update is retained until the source becomes visible. Worker failures clear stale imagery and display a retry message; toggling the layer recreates the worker.

## Modules and diagnostics

- `stream.ts`: session-aware SSE, raw frames, scenario/playback actions, and state gates.
- `grid.ts`: grid types and shared sparse density sampling; GeoJSON conversion remains a comparison/test utility, not the runtime renderer.
- `raster.ts` / `raster.worker.ts`: scalar smoothing, Mercator sampling, palette, and worker transport.
- `rasterQueue.ts` / `RasterHeatmap.tsx`: bounded scheduling and canvas/map lifecycle.
- `layer.ts`: raster opacity/resampling/fade.
- `useDemandInspection.ts`: exact cell inspection, independent of raster pixels.

Open `?debugHeatmap` for grid/frame diagnostics plus raster dimensions and last worker generation duration. That duration excludes worker dispatch, main-thread canvas copying, and GPU upload.

## Validation

Run `npm test`, `npm run lint`, `npm run build`, and `npm run test:e2e`. Numerical tests cover smoothing, fixed colors, orientation, mask fallback, and transparent empty frames. Lifecycle tests cover stale jobs, resets, mask/config changes, hide/show, resource disposal, and style recreation.

`scripts/profile-map.mjs` measures worker generation/round-trip durations, hover latency, pan frame intervals, and page heap; it captures screenshots at multiple views. Set `PROFILE_RENDERER=circles` to profile an old checkout, and `PROFILE_REAL_BASEMAP=1` for shoreline visual checks. Worker and GPU memory are not included in the page heap measurement. Fixture-basemap timing is not production FPS.

## Local comparison (2026-10-15)

Baseline: deployed commit `f015cb1`, with the same 250 m grid. Both runs use Chromium 156, a 1280×800 viewport, a paused Monday-noon frame, a deterministic empty basemap, and a page CPU throttle of 2×.

| Measurement | Circles | Continuous raster |
| --- | ---: | ---: |
| Preparation median / p95 | 0.9 / 1.5 ms, main thread | 4.5 / 4.7 ms, worker |
| Worker round trip p95 | n/a | 5.6 ms |
| Hover DOM-update p95 | 10.1 ms | 9.6 ms |
| Pan frame interval p95 | 50.1 ms | 50.0 ms |
| Settled startup page heap | 19.17 MB | 17.30 MB |

The raster passes the 100 ms generation target and 20% hover/pan regression limits in this run. No main-thread long tasks were observed during the settled generation benchmark. This does not assert that startup or every map interaction is free of long tasks. Worker CPU-throttle equivalence is not independently verified. The old conversion timing excludes GeoJSON source processing; raster timing excludes canvas copying/GPU upload, so preparation timings are not total-render-cost comparisons.

The real Carto comparison also showed no hover/pan regression: hover p95 9.8 → 9.7 ms, pan interval p95 116.7 → 100.0 ms. It did observe 93–99 ms main-thread tasks during the raster measurement window. Those timings include concurrent basemap activity and do not isolate canvas/GPU upload; a blanket 50 ms end-to-end map-task guarantee is **not** established. These software-rendered browser results are not hardware-GPU production frame rates.

Raw measurements: [continuous-heatmap-performance.json](continuous-heatmap-performance.json). Screenshots and traces are local ignored artifacts under `test-results/profile-circles/`, `test-results/profile-raster/`, and `test-results/profile-raster-real/`. Set `PROFILE_VISUAL_SWEEP=1` for additional regional, residential, and crowd-drop screenshots.

No commit or deployment is part of this change. Release through the existing verified-SHA CI/deploy workflow when authorized; rollback uses the previous frontend image. No data migration or mask regeneration is required.

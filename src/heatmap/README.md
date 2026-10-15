# Frontend heatmap

See [frontend rendering and lifecycle](../../docs/frontend-heatmap.md) for the current continuous-field renderer and [the HTTP/SSE contract](../../docs/heatmap-api-contract.md) for the real/mock interface.

The SSE hook retains raw accepted frames. While visible, a worker produces a ground-aligned 560×896 density raster from the 112×70 simulation grid. Density is smoothed before applying a fixed palette; there are no colored sample discs. Raw tooltip values remain at the modeled ~250 m resolution.

The building mask shapes ~125 m samples. The raster smooths those samples with an 80 m Gaussian, then bilinearly resamples in Web Mercator. The basemap water polygons clip the result at the shoreline. Missing or incompatible masks render without building shaping.

## Change checklist

- Keep backend and mock contracts in sync if changing wire data; this renderer changes neither.
- Keep raw hover metrics independent of rendered colors.
- Test worker scheduling and map-resource cleanup alongside numerical rendering.
- Compare pitched/top-down, dense/sparse, and shoreline views.
- Profile worker generation, UI latency, pan frames, and memory before rollout.


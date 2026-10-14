# Runtime performance checks

The September 2026 optimization pass addresses asset transfer, broad animation
updates, duplicate paused frames, per-reader encoding, and crowd mutation bursts.

## Reproduce

```bash
npm ci
npm run optimize:landmark  # after changing the original GLB
npm test
npm run lint
npm run build             # includes artifact-size budgets
.venv/bin/python -m pytest backend/tests data_processing/tests
# With a disposable local backend on 127.0.0.1:8000:
node scripts/smoke-sse.mjs
```

The smoke check changes playback temporarily, opens 1/10/100 SSE subscribers,
checks identical paused frames and subsequent heartbeats, adds a 12-cluster batch,
checks that it wakes the stream, then removes those crowds and restores playback.
Use it only against a local test server, not while another person is using it.

## Observed results

- Landmark: 52,319,056 → 2,784,092 bytes (94.7% reduction). Its sole texture is
  2048×2048 WebP instead of 8192×8192 PNG; geometry bytes and accessors are unchanged.
  The original remains tracked for regeneration but is excluded from production.
- Main JS entry: approximately 1.33 MB → 0.30 MB minified. This measures deferred
  code, not an equivalent reduction in total JavaScript downloaded after all
  optional features load. MapLibre itself still accounts for roughly 1.03 MB.
- Production excludes the original landmark and three unused legacy map assets
  (18.18 MB combined). `scripts/check-asset-budgets.mjs` enforces these exclusions
  and limits the landmark to 8 MB and the entry bundle to 600 kB.
- Region sources now follow the current padded viewport and are removed outside
  it. Citywide zoom can still require all five large region files; vector tiling
  is a future option if measured memory/render time warrants it.
- Regression tests confirm the animation subtree updates without rerendering its
  parent, the landmark creates a fresh layer when re-entering view, paused ticks
  reuse frames, 100 readers share one encoding, and invalid crowd batches are atomic.
- Local HTTP smoke: 1, 10 and 100 readers each received identical paused frames
  and comment heartbeats; a batch woke the paused stream and preserved its count.
  This is a functional concurrency check, not a throughput/capacity benchmark.

Validation used Node 25.6.1 and Python 3.14.5 locally. Production images remain
Node 22 (build) and Python 3.12. Browser automation was unavailable during this
pass: visual texture quality, GPU frame time and browser memory still need a
browser trace. No FPS or production-capacity improvement is claimed.

For future profiling, record cold-cache startup and long tasks, pan downtown to
West Seattle and back, toggle the landmark and heatmap, compare 60/120 Hz displays,
and measure memory at citywide zoom. Preserve shared producer semantics when
scaling the backend; multiple independent uvicorn workers are not a safe shortcut.

## October 2026 measured comparison

The unchanged `be7153e` baseline and the updated source were exercised with
`scripts/profile-map.mjs`, Chromium 156.0.8078.4, a 1280×800 viewport, 2× CPU
throttling, 20 Mbps download/30 ms latency, and the same deterministic empty basemap.
Both runs used development builds. The fixture removes external basemap variability;
these timings do not predict production startup or GPU frame rate.

| Measurement | Baseline | Updated |
| --- | ---: | ---: |
| Application ready | 24.30 s | 2.92 s |
| Startup building response bytes, decoded | 29.80 MB | 0.32 MB |
| Page JS heap after startup GC | 85.12 MB | 15.19 MB |
| Page JS heap after pan/zoom/return GC | 122.72 MB | 18.09 MB |

Page heap excludes MapLibre workers and GPU memory. Decoded response bytes are not
compressed transfer sizes. The pan/zoom gesture sequence is reproducible but is
not a complete device benchmark. Screenshots preserve the building appearance.
Decoding all maximum-zoom tiles confirmed all 123,623 source OBJECTIDs and heights,
with zero missing identifiers or height mismatches.

Raw reports and Playwright traces are in local `test-results/profile-baseline/`
and `test-results/profile-current/`; the numerical reports are also recorded in
`performance-2026-10.json`. Reproduce with a baseline checkout whose Vite proxy
targets port 8010, then run the two commands sequentially:

```bash
node scripts/profile-map.mjs /path/to/baseline 8010 5180 baseline
node scripts/profile-map.mjs . 8000 5181 current
```

Both commands manage disposable backend/frontend servers and close them on exit.
Install Playwright Chromium first and set `PYTHON` if needed. Existing production
asset budgets still apply; tile budgets are now included.

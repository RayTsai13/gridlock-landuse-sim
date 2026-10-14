# October 2026 implementation

## Simulation lifecycle

The browser calls `POST /api/session` before starting the application. The server
creates or resumes an opaque `gridlock_session` cookie (`HttpOnly`, `SameSite=Lax`,
path `/api`, `Secure` on HTTPS). Its response is `{created, reset}`. No tokens are
stored in JavaScript or included in URLs. Separate browsers have private sessions;
tabs sharing a cookie share one simulation. Refresh resumes the confirmed state.

All other `/api/*` routes require the session and return HTTP 401 with
`code: session_expired` when it is absent or expired. The client recreates the
session and displays a reset notice, without retrying a rejected mutation. A failed
SSE connection also checks the session before reconnecting. Cross-origin mutations
are rejected. Development proxies must preserve the incoming Host header.

`SESSION_TTL_SECONDS` defaults to 1800 seconds without API activity or subscribers.
`SESSION_LIMIT` defaults to 100; full capacity returns 503 with `Retry-After: 30`.
Active SSE subscribers keep their session alive. Disconnected simulations stop
advancing. One producer advances each active simulation once per tick, and all
readers of that simulation share frame composition and JSON encoding. Grid,
land-use, and service artifacts are shared immutable inputs. Mutable overlays,
playback, scenario and frame caches are private. Run exactly one backend worker.
Sessions are intentionally temporary; restarts reset them. No database is required.

## Model and wire contract additions

Scenario responses and SSE events contain `scenario_id`, `stops`, and `lines`.
The UI renders server-confirmed state and no longer writes Line 1 during mounting.

Frames retain sparse `[row, col, density]` display tuples and add:

```json
{
  "cell_metrics": [[0, 0, 12000, 2000, 10000]],
  "totals": {"generated": 12000, "served": 2000, "unmet": 10000},
  "model": {"synthetic": false, "effectiveTripsPerDeparture": 200, "walkRadiusMeters": 900}
}
```

`cell_metrics` tuples are `[row, col, generated, served, unmet]` in trips/hour.
They include every cell with positive generated demand, independently of display
thresholds, saturation, interpolation, and building-mask shaping. Missing cells
have zero generated demand. Generated equals served plus unmet. The tooltip uses
the geographic cell under the pointer, outlines it, and reports its actual modeled
totals. Pressure is a separate visual index. Mock metrics are explicitly synthetic.

The shared version-1 `public/seattle/train-service.json` contains paths, profiles,
source metadata, and representative departures. The browser fetches it separately
from JavaScript; the backend loads the same file. Stop capacity counts arrivals
over the next simulated hour, including both directions, prior-day services,
travel time and intermediate dwell, multiplied by 200 effective absorbed trips per
departure. This is a demo assumption, not train occupancy. Missing required day
profiles or incompatible geometry fail artifact validation. Custom networks must
reference supported line/stop profiles; requests with unscheduled lines or stops
return 400 atomically instead of silently creating zero-capacity service.

The October refresh uses `SC-Fall-2026.4`, valid 2026-09-01 through 2027-03-26.
Ballard remains synthetic. After feed expiry the UI labels the schedule historical
and remains usable. Population/rate tables and 900-meter walksheds remain authored
assumptions. There is no routing, transfer, onboard-load, or observed-demand
calibration. Results are explanatory, not validated predictions.

To refresh (from repository root):

```bash
curl -L --fail https://www.soundtransit.org/GTFS-rail/40_gtfs.zip -o /tmp/gridlock-rail.zip
.venv/bin/python data_processing/scripts/build_train_service_profiles.py --rail-gtfs-zip /tmp/gridlock-rail.zip
npm test
.venv/bin/python -m pytest backend/tests data_processing/tests
```

## Building assets

Install/build **Tippecanoe 2.79.0** from `https://github.com/felt/tippecanoe` and run:

```bash
TIPPECANOE=/path/to/tippecanoe npm run build:tiles
npm run build
```

The generator deduplicates buildings by OBJECTID, validates heights, keeps identifiers
and extrusion height, and generates buffered gzip vector tiles at zooms 8–15.
Detailed geometry uses 14-bit tile precision at the maximum zoom. Lower zooms
simplify geometry and drop small buildings as needed to stay below 500 KB per tile.
It publishes a content-versioned XYZ directory, TileJSON manifest and build report.
The source GeoJSON remains available for regeneration but is excluded from builds.
Old version directories may be retired separately after cached clients expire.

The first build contains 123,623 unique buildings in 630 tiles (including empty water tiles), 18,134,228 compressed
bytes total, with a maximum tile of 440,656 bytes. The fixed downtown budget envelope
(-122.37, 47.59)–(-122.30, 47.63) at zoom 14 totals 716,214 compressed bytes. This is an
asset measurement, not a browser FPS or capacity claim. Build checks enforce 500 KB
per tile, 5 MB for this envelope, existing JS/landmark budgets, and exclusion of
regional GeoJSON. Nginx sends gzip/content-type headers; Vite decompresses tiles in
development. TileJSON and service metadata revalidate; versioned tiles cache for a year.

## Verification

```bash
npm test
npm run lint
npm run build
.venv/bin/python -m pytest backend/tests data_processing/tests
npx playwright install chromium
npm run test:e2e
```

Browser tests start disposable local servers, check independent browsers, shared
tabs, refresh, server-confirmed scenarios, cell totals, building tile requests and
tooltips. `PYTHON` can override `.venv/bin/python` in browser-test configuration.
Do not run them against an existing simulation on port 8000. With a disposable
server already running, `node scripts/smoke-sse.mjs` creates its own session and
checks 1/10/100 SSE readers, paused heartbeats and atomic crowds.

The Docker configuration builds the same service artifact and tile assets. Domain
activation and deployment verification are documented in `deployment.md`.

# Gridlock

> 🏆 **Finalist Prize — UWBHacks 2026**

Gridlock is an interactive Seattle transit-demand simulator. A React/TypeScript map displays cached Seattle building geometry, transit build-out scenarios, animated trains, and a foot-traffic pressure heatmap streamed by a FastAPI backend over Server-Sent Events (SSE).

The simulation is analytical rather than machine-learned at runtime: land-use populations generate trips, active transit stops absorb capacity, and the remaining trips are rendered as demand pressure.

## Quick start

Requirements:

- Node.js 22 and npm
- Python 3.12
- Docker and Docker Compose, only for the containerized workflow

Install the frontend dependencies:

```bash
npm ci
```

Create a Python environment and install the backend dependencies:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.txt
```

Start the real simulation backend in one terminal:

```bash
.venv/bin/python -m uvicorn backend.server:app --host 0.0.0.0 --port 8000
```

Start the frontend in another terminal:

```bash
npm run dev
```

Open `http://localhost:5173`. The frontend requests same-origin `/api/*` paths, and Vite proxies them to the backend on port 8000.

For frontend-only work, the synthetic server implements the same frontend-facing API without loading the Seattle grid artifact:

```bash
npm run mock:server
```

Do not run the real backend with multiple workers. Its simulation state and frame producer are process-global, so multiple workers create independent timelines.

## What is in the repository

| Path | Purpose |
| --- | --- |
| [`src/`](src/README.md) | React map, heatmap client, scenario UI, building layers, and train animation |
| [`backend/`](backend/README.md) | GeoJSON-backed FastAPI simulation and SSE server |
| [`mock/`](mock/README.md) | Synthetic development server with backend-compatible HTTP/SSE behavior |
| [`docs/`](docs/README.md) | Runtime architecture and wire-contract documentation |
| [`seattle/`](seattle/README.md) | Seattle building and grid preprocessing |
| [`data_processing/`](data_processing/README.md) | Offline GTFS, census, and feature-generation utilities; not imported at runtime |
| `public/seattle/` | Checked-in building regions and other browser-served Seattle assets |

The frontend and both servers share the contract in [`docs/heatmap-api-contract.md`](docs/heatmap-api-contract.md). If a frame, scenario, playback, or crowd endpoint changes, update all three implementations/consumers and the parity tests together.

## Commands

Frontend:

```bash
npm run dev          # Vite development server
npm test             # Vitest once
npm run test:watch   # Vitest in watch mode
npm run lint         # ESLint
npm run build        # TypeScript project build + Vite production build
npm run preview      # preview the production bundle
```

Backend and data-processing tests:

```bash
.venv/bin/python -m pytest backend/tests
.venv/bin/python -m pip install -r data_processing/requirements.txt
.venv/bin/python -m pytest data_processing/tests
```

The backend tests include endpoint-level parity checks against `mock/server.py`. Run commands from the repository root; `pyproject.toml` configures pytest and async-test discovery.

## Docker

Build and run the production frontend, backend, and Caddy reverse proxy:

```bash
docker compose up --build
```

Open `http://localhost`. Caddy listens on port 80 and forwards to nginx; nginx serves the frontend and proxies `/api/*` and `/healthz` to the backend.

Useful checks:

```bash
docker compose ps
curl http://127.0.0.1/healthz
```

The image names in `docker-compose.yml` are placeholders for local builds. The current `Caddyfile` serves plain HTTP on `:80`; publishing port 443 does not enable HTTPS without a configured site address.

Production is deployed from `RayTsai13/gridlock-landuse-sim` to the
DigitalOcean droplet `gridlock-prod` through GitHub Actions. See the
[production deployment runbook](docs/deployment.md) for the current target,
required secrets, verification commands, and recovery procedures.

## Runtime configuration

The real backend accepts these environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEATMAP_GEOJSON` | `seattle/data/processed/seattle_heatmap_grid.geojson` | Grid `FeatureCollection`; geometry determines bounds, rows, and columns |
| `HEATMAP_FRAME_INTERVAL` | `1.0` | Wall-clock seconds between frame ticks |
| `HEATMAP_SIM_STEP_SECONDS` | `1800` | Simulated seconds advanced per frame |

Simulation calibration lives in `backend/demand.py`, `backend/network.py`, `backend/overlays.py`, and `backend/composer.py`, not in environment variables.

## Documentation

Start with the [documentation index](docs/README.md). The most important references are:

- [Heatmap HTTP/SSE contract](docs/heatmap-api-contract.md)
- [Frontend heatmap integration](docs/frontend-heatmap.md)
- [Seattle map and building architecture](docs/seattle-map-architecture.md)
- [Production deployment runbook](docs/deployment.md)
- [Backend implementation guide](backend/README.md)
- [Offline data-processing guide](data_processing/README.md)

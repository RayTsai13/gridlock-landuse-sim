# Mock server

`mock/server.py` is a synthetic FastAPI server for frontend development. It generates moving Seattle-shaped hotspots over a `57 × 36` grid and needs no GeoJSON or data-pipeline artifacts.

It implements the same frontend-facing scenario, playback, people, and SSE behavior as the real backend. `/healthz` is specific to the production backend and is not provided here. See [`../docs/heatmap-api-contract.md`](../docs/heatmap-api-contract.md).

## Run

From the repository root, after installing `backend/requirements.txt` or `backend/requirements-dev.txt`:

```bash
npm run mock:server
```

The equivalent direct command is:

```bash
python3 -m uvicorn mock.server:app --host 0.0.0.0 --port 8000
```

Then run `npm run dev` in another terminal and open `http://localhost:5173`.

Only one service can bind port 8000 at a time, so stop the real backend before starting the mock.

## Behavior

- Scenario ids add cumulative groups of synthetic hotspots so deployments visibly change the map.
- A simple coastline mask keeps generated activity off major water areas.
- Crowd drops add short-lived local density.
- Playback and SSE handshakes mirror the real server.
- A single lifespan ticker produces shared frames; connections do not advance the clock themselves.

Endpoint parity is enforced by `backend/tests/test_server_parity.py`:

```bash
python3 -m pytest backend/tests/test_server_parity.py
```

When the frontend-facing wire contract changes, update the real server, this mock, the TypeScript client, tests, and contract document together.


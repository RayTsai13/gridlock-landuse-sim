# Frontend heatmap

This folder owns the frontend side of the simulation API. The complete protocol is documented in [`../../docs/heatmap-api-contract.md`](../../docs/heatmap-api-contract.md), with additional rendering detail in [`../../docs/frontend-heatmap.md`](../../docs/frontend-heatmap.md).

## Modules

| Module | Responsibility |
| --- | --- |
| `api.ts` | Typed HTTP mutations for scenarios, playback, and people |
| `stream.ts` | `useHeatmap`, EventSource lifecycle, handshake state, frame gates, diagnostics, and retries |
| `grid.ts` | Grid/frame types and sparse-cell to GeoJSON conversion with 3×3 interpolation |
| `layer.ts` | MapLibre point-layer styling |
| `__tests__/` | Conversion and stream-lifecycle tests |

## Event lifecycle

The server sends `config`, `scenario`, and `playback` in that order, followed by repeated `frame` events. `stream.ts` discards frames until it has a grid config and while a scenario mutation is awaiting confirmation.

On every new `config` event, reconnect-sensitive gates are reset. This is required because a restarted backend begins its `state_version` counter at zero. After three consecutive EventSource errors, the hook exposes a failed state and a manual retry action.

Frame conversion is skipped while the layer is hidden. The latest raw frame is retained and converted immediately if rendering is re-enabled.

## Change checklist

When changing the wire format or endpoint behavior:

1. Update `backend/server.py` and `mock/server.py`.
2. Update the types and handlers here.
3. Update `backend/tests/test_server_parity.py` and frontend tests.
4. Update `docs/heatmap-api-contract.md`.


# Frontend heatmap

This folder owns the frontend side of the simulation API. The complete protocol is documented in [`../../docs/heatmap-api-contract.md`](../../docs/heatmap-api-contract.md), with additional rendering detail in [`../../docs/frontend-heatmap.md`](../../docs/frontend-heatmap.md).

## Modules

| Module | Responsibility |
| --- | --- |
| `api.ts` | Typed HTTP mutations for scenarios, playback, and people |
| `stream.ts` | `useHeatmap`, EventSource lifecycle, handshake state, frame gates, diagnostics, and retries |
| `grid.ts` | Grid/frame types and sparse-cell to GeoJSON conversion with 4×4 interpolation, shaped by the built-mass field |
| `mask.ts` | `useBuiltMass`, the fetch and parse of `/seattle/seattle-built-mass.json` |
| `layer.ts` | MapLibre point-layer styling |
| `__tests__/` | Conversion and stream-lifecycle tests |

## Event lifecycle

The server sends `config`, `scenario`, and `playback` in that order, followed by repeated `frame` events. `stream.ts` discards frames until it has a grid config and while a scenario mutation is awaiting confirmation.

On every new `config` event, reconnect-sensitive gates are reset. This is required because a restarted backend begins its `state_version` counter at zero. After three consecutive EventSource errors, the hook exposes a failed state and a manual retry action.

Frame conversion is skipped while the layer is hidden. The latest raw frame is retained and converted immediately if rendering is re-enabled, and likewise when the built-mass field finishes loading.

## Making the field follow the city

Three things keep heat on land, and they operate at different resolutions:

1. **The backend** weights demand by built mass per ~500 m cell, so the Gaussians never generate demand over open water in the first place.
2. **`grid.ts`** shapes each cell's 16 sub-samples by the ~125 m built-mass field. The shaping is *mean-preserving*: a cell keeps the brightness the server gave it but spends it on the sub-blocks that hold buildings, so a shoreline cell lights its waterfront and not the bay. A mask whose `rows`/`cols` do not match the live grid config is ignored rather than mis-applied — that is what makes the 57×36 mock server degrade to unshaped rendering instead of garbage.
3. **`App.tsx`** redraws the basemap's own `water` polygons in a `heatmap-water-clip` layer directly above the heatmap, clipping it at full vector-tile resolution. The heatmap targets that layer by id in its `beforeId`, so ordering does not depend on JSX mount order.

`layer.ts` sizes each sample disc with an `["exponential", 2]` zoom interpolation, which makes the radius double per zoom level and so track the ground distance between samples. A radius that does not scale this way is the difference between a continuous field and either polka dots (too small, zoomed in) or one undifferentiated blob (too large, zoomed out).

## Change checklist

When changing the wire format or endpoint behavior:

1. Update `backend/server.py` and `mock/server.py`.
2. Update the types and handlers here.
3. Update `backend/tests/test_server_parity.py` and frontend tests.
4. Update `docs/heatmap-api-contract.md`.


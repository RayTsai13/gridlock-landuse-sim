# Frontend source

This directory contains the React 19 + TypeScript frontend. Vite starts the app from `main.tsx`; `App.tsx` composes the Seattle map, vector-tiled buildings, heatmap, transit scenarios, playback controls, crowd interactions, and deck.gl objects.

## Run and verify

From the repository root:

```bash
npm ci
npm run dev
npm test
npm run lint
npm run build
```

The development server runs at `http://localhost:5173` and proxies same-origin `/api/*` calls to `http://localhost:8000`. Start either the [real backend](../backend/README.md) or [mock server](../mock/README.md) separately.

## Layout

| Path | Responsibility |
| --- | --- |
| `main.tsx` | React root and global stylesheet entry |
| `App.tsx` | Top-level UI and map composition |
| `App.css`, `index.css` | Application and global styling |
| `DeckGLOverlay.tsx` | MapLibre/deck.gl overlay bridge |
| `MapOverlays.tsx`, `SpaceNeedle.ts` | Deferred animation subtree and viewport-gated landmark |
| `heatmap/session.tsx`, `useTimeControls.ts`, `useCrowdDrop.ts`, `useDemandInspection.ts` | Session initialization and focused interaction hooks |
| `Mascot.tsx`, `Mascot.css` | Draggable crowd-placement mascot |
| [`heatmap/`](heatmap/README.md) | HTTP client, SSE lifecycle, frame conversion, and density styling |
| [`stops/`](stops/README.md) | Transit definitions, MapLibre layers, track geometry, and train synthesis |
| `assets/` | Source-controlled assets bundled by Vite |

Browser-served building vector tiles and the Space Needle model live in `../public/seattle/`, not under `src/assets/`.

## Boundaries to preserve

- Use same-origin `/api` URLs. Vite handles development proxying and nginx handles production proxying.
- Treat each heatmap frame as a complete sparse snapshot. Do not accumulate it as a delta.
- Wait for the server-owned grid config; do not hard-code real-backend rows or columns in the renderer.
- Preserve `state_version` gating across scenario changes and reset it after an SSE reconnect/config handshake.
- Drive animated trains from the server's playback rate and simulation time.
- TypeScript module imports use explicit `.ts` or `.tsx` extensions; stylesheet imports retain their normal extension.

`App.tsx` is intentionally the current integration point but is large. New isolated behavior should prefer a focused hook or module instead of extending unrelated responsibilities there.

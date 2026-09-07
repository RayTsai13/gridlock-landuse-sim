# Documentation index

This directory contains the current runtime design and public interface documentation.

| Document | Scope | Update when |
| --- | --- | --- |
| [`heatmap-api-contract.md`](heatmap-api-contract.md) | Canonical HTTP/SSE contract shared by the real backend, mock, and frontend | An endpoint, event, payload, ordering rule, or state gate changes |
| [`frontend-heatmap.md`](frontend-heatmap.md) | EventSource lifecycle and MapLibre conversion/rendering | `src/heatmap/` behavior changes |
| [`seattle-map-architecture.md`](seattle-map-architecture.md) | Cached Seattle building data and runtime loading | Building regions, asset generation, or layer ordering changes |

Folder-specific implementation guides live beside their code:

- [`../backend/README.md`](../backend/README.md)
- [`../mock/README.md`](../mock/README.md)
- [`../src/README.md`](../src/README.md)
- [`../src/heatmap/README.md`](../src/heatmap/README.md)
- [`../src/stops/README.md`](../src/stops/README.md)
- [`../seattle/README.md`](../seattle/README.md)
- [`../data_processing/README.md`](../data_processing/README.md)

The long documents in `data_processing/` named `ARCHITECTURE.md`, `DEMAND_PIPELINE_PROCESS.md`, and `INTERACTIVE_TIMELAPSE_PROPOSAL.md` are historical design records for a removed model-training path. They are useful background, but they are not current runbooks or runtime architecture.

## Documentation conventions

- Prefer one canonical source and link to it rather than copying payload schemas into several files.
- Keep runnable commands relative to the directory explicitly named above the code block.
- Mark generated artifacts and historical plans clearly.
- Update documentation in the same change as its corresponding code or contract.

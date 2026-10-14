# Transit stops and trains

This folder defines the transit build-out shown by the frontend and synthesizes animated train positions from server-owned simulation time.

## Modules

| Module | Responsibility |
| --- | --- |
| `data.ts` | Stop/line types, built-in Link and Ballard scenarios, deployment steps, and GeoJSON helpers |
| `layers.ts` | MapLibre styles for lines, stops, labels, and deployment effects |
| `track_geometry.ts` | Detailed line paths used for rendering and interpolation |
| `train_service.ts` | Service types; generated data lives in `public/seattle/train-service.json` |
| `trains.ts` | Departure synthesis, path interpolation, line offsets, and the playback interpolation hook |
| `__tests__/` | Train timing and interpolation tests |

## Train-service generation

Regenerate `public/seattle/train-service.json` from an official Sound Transit rail GTFS archive with:

```bash
cd data_processing
.venv/bin/python scripts/build_train_service_profiles.py \
  --rail-gtfs-zip curr_data/raw/40_gtfs.zip
```

The generator reads `src/stops/track_geometry.ts` by default and writes `public/seattle/train-service.json`. Review both the generated diff and `metadata.sourceFeedEndDate`; the application labels expired feeds as historical while keeping the demo usable.

`track_geometry.ts` and `train_service.ts` must agree on line ids, stop order, and path distances. `trains.ts` degrades to a parked train for some length mismatches, but that is a safety fallback rather than a valid generated state.

## Timing contract

- The backend's `playback.sim_time.minute_of_week` is the synchronization point.
- `playback.sim_minutes_per_second` is authoritative for smooth client-side interpolation.
- The local animation clock resynchronizes when playback changes or drift exceeds the threshold in `trains.ts`.
- A missing service profile means no trains are rendered for that line/day type.

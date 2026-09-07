# Offline data processing

This directory contains build-time data utilities for GTFS, census, station-vector, and heatmap feature artifacts. Nothing under `data_processing/` is imported by the FastAPI backend or React frontend at runtime.

The former model-training and scoring code has been removed. Some builders still produce tables named `*_training_features.csv` or scenario candidate features; these are research inputs only, and this repository does not currently train or load a model from them.

One exception to the runtime separation is code generation: `scripts/build_train_service_profiles.py` intentionally writes the generated frontend module `../src/stops/train_service.ts`.

## Setup

Run the commands in this document from `data_processing/`:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

The downloads and geospatial builds can be large. Existing non-empty raw files are reused by the download script.

## Directory layout

| Path | Purpose |
| --- | --- |
| `scripts/download_raw_data.py` | Cache Delhi, Census, Fremont, accessibility, and Puget Sound GTFS inputs |
| `scripts/filter_gtfs_station_data.py` | Produce a rail/station-only GTFS subset |
| `scripts/build_features.py` | Orchestrate the current feature builders |
| `scripts/build_train_service_profiles.py` | Generate frontend train service profiles from rail GTFS |
| `src/common/` | Shared artifact names, I/O, geospatial, station, GTFS, heatmap, and service-profile helpers |
| `src/pipelines/delhi/` | Delhi population, trip, GTFS-frequency, and heatmap-feature builders |
| `src/pipelines/seattle/` | Seattle station-vector and proxy heatmap-grid builders |
| `src/pipelines/common/` | City-grid candidate feature generation and scenario inputs |
| `curr_data/raw/` | Cached source data |
| `curr_data/processed/features/` | Generated feature tables and grids |
| `gtfs/` | Extracted multimodal Puget Sound GTFS |
| `gtfs_stations/` | Generated Sound Transit rail/station subset |
| `gtfs_delhi/` | Optional extracted Delhi GTFS |

## Build the current feature set

The orchestration script downloads/reuses raw inputs, filters Seattle GTFS, and runs the Delhi, Seattle, and city-candidate builders in dependency order:

```bash
.venv/bin/python scripts/build_features.py
```

Common options:

```bash
.venv/bin/python scripts/build_features.py --skip-download
.venv/bin/python scripts/build_features.py --skip-seattle-heatmap
.venv/bin/python scripts/build_features.py --include-lehd --lehd-year 2022
.venv/bin/python scripts/build_features.py --agency-ids 40 --route-types 0,1,2
```

Use `--help` on the wrapper or an individual module for the complete option set.

### Download and cache only

```bash
.venv/bin/python scripts/download_raw_data.py
```

By default this populates `curr_data/raw/`, downloads/extracts Puget Sound GTFS into `gtfs/`, and validates the Delhi trip CSV required by `src.pipelines.delhi.transform_metro`.

The default Delhi trip source is the Kaggle dataset `nikhilkumar766/delhi-metro-dataset`. If Kaggle authentication is required, set `KAGGLE_USERNAME` and `KAGGLE_KEY` in the environment. Delhi GTFS is optional because there is no stable DMRC URL configured; provide `--delhi-trips-url`, `--delhi-gtfs-url`, or `--kaggle-delhi-gtfs-dataset` when using another source.

`scripts/download_raw_data.sh` is a compatibility wrapper around the Python downloader.

### Filter Seattle GTFS

The source feed includes buses and ferries. Build the station-oriented subset before Seattle station or heatmap work:

```bash
.venv/bin/python scripts/filter_gtfs_station_data.py \
  --input-gtfs-dir gtfs \
  --output-gtfs-dir gtfs_stations \
  --route-types 0,1,2 \
  --agency-ids 40
```

The defaults retain rail-style route types and Sound Transit (`agency_id` 40). The source `gtfs/` directory remains unchanged.

## Individual pipelines

### Delhi station and trip features

```bash
.venv/bin/python -m src.pipelines.delhi.build_population_vectors \
  --raw-dir curr_data/raw \
  --out-dir curr_data/processed/features

.venv/bin/python -m src.pipelines.delhi.transform_metro \
  --input curr_data/raw/delhi_metro_updated.csv \
  --density-vectors curr_data/processed/features/delhi_station_density.csv \
  --out-dir curr_data/processed/features
```

These commands create station density, station-vector, and trip-feature tables. They do not create a train/test split or fit a model.

Optional Delhi GTFS context and the retained heatmap-training feature table:

```bash
.venv/bin/python -m src.pipelines.delhi.build_gtfs_frequency \
  --gtfs-dir gtfs_delhi \
  --station-vectors curr_data/processed/features/delhi_station_vectors.csv \
  --out-dir curr_data/processed/features

.venv/bin/python -m src.pipelines.delhi.build_heatmap_training_dataset \
  --trip-features curr_data/processed/features/delhi_trip_features.csv \
  --station-vectors curr_data/processed/features/delhi_station_vectors.csv \
  --frequency-csv curr_data/processed/features/delhi_station_gtfs_frequency.csv \
  --out-dir curr_data/processed/features
```

If Delhi GTFS is absent, the frequency builder emits zero-frequency fallback rows so downstream feature generation remains reproducible.

### Seattle station vectors

```bash
.venv/bin/python -m src.pipelines.seattle.build_station_vectors \
  --gtfs-dir gtfs_stations \
  --raw-dir curr_data/raw \
  --out-dir curr_data/processed/features
```

This combines station-only GTFS with ACS/TIGER population context. `--include-lehd` belongs to the Seattle heatmap builder, not the station-vector builder.

### Seattle proxy heatmap features

```bash
.venv/bin/python -m src.pipelines.seattle.build_heatmap_dataset \
  --gtfs-dir gtfs_stations \
  --raw-dir curr_data/raw \
  --out-dir curr_data/processed/features \
  --fremont-limit 5000
```

Outputs are a proxy feature table and grid GeoJSON. They are offline artifacts, not measured pedestrian volume. The live backend reads the separately checked-in `../seattle/data/processed/seattle_heatmap_grid.geojson` only for grid geometry; it ignores proxy scores and generates demand analytically.

Optional LEHD workplace data:

```bash
.venv/bin/python -m src.pipelines.seattle.build_heatmap_dataset \
  --gtfs-dir gtfs_stations \
  --raw-dir curr_data/raw \
  --out-dir curr_data/processed/features \
  --include-lehd \
  --lehd-year 2022
```

### City candidate features

```bash
.venv/bin/python -m src.pipelines.common.build_heatmap_candidates \
  --station-vectors curr_data/processed/features/seattle_station_vectors.csv \
  --gtfs-dir gtfs_stations \
  --out-dir curr_data/processed/features
```

The builder can apply `--added-stations-csv`, `--removed-stations-csv`, and `--frequency-delta-csv`. It stops at feature generation: no current code scores those candidates or sends them to the runtime backend.

### Frontend train-service profiles

Download the official Sound Transit rail GTFS archive as `curr_data/raw/40_gtfs.zip`, then run:

```bash
.venv/bin/python scripts/build_train_service_profiles.py \
  --rail-gtfs-zip curr_data/raw/40_gtfs.zip
```

The script combines GTFS schedules with `../src/stops/track_geometry.ts` and overwrites the generated `../src/stops/train_service.ts`. Review the source-feed metadata and run the frontend train tests after regeneration.

## Main outputs

| Artifact | Producer |
| --- | --- |
| `delhi_station_density.csv` | `build_population_vectors` |
| `delhi_station_vectors.csv`, `delhi_trip_features.csv` | `transform_metro` |
| `delhi_station_gtfs_frequency.csv` | `build_gtfs_frequency` |
| `delhi_heatmap_training_features.csv` | `build_heatmap_training_dataset` |
| `seattle_station_vectors.csv` | `build_station_vectors` |
| `seattle_heatmap_features.csv`, `seattle_heatmap_grid.geojson` | `build_heatmap_dataset` |
| `city_heatmap_candidate_features.csv`, `heatmap_timelapse_grid.geojson` | `build_heatmap_candidates` |
| `../src/stops/train_service.ts` | `build_train_service_profiles.py` |

Unless overridden, feature CSV/GeoJSON outputs are written below `curr_data/processed/features/` by `scripts/build_features.py`.

## Tests

From the repository root, install both test and data dependencies and run:

```bash
.venv/bin/python -m pip install -r backend/requirements-dev.txt
.venv/bin/python -m pip install -r data_processing/requirements.txt
.venv/bin/python -m pytest data_processing/tests
```

The current tests cover train-service profile generation. Pipeline commands also print summaries that should be reviewed after rebuilding data.

## Historical documents

The following files describe a removed model-training/scoring architecture and are retained only for design history:

- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`DEMAND_PIPELINE_PROCESS.md`](DEMAND_PIPELINE_PROCESS.md)
- [`INTERACTIVE_TIMELAPSE_PROPOSAL.md`](INTERACTIVE_TIMELAPSE_PROPOSAL.md)

Do not use commands in those historical documents as current runbooks. The current runtime architecture is documented in [`../backend/README.md`](../backend/README.md) and [`../docs/heatmap-api-contract.md`](../docs/heatmap-api-contract.md).

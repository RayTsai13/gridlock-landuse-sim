#!/usr/bin/env python3
"""Build the per-subcell built-mass field used to shape the heatmap.

The simulation's land use is a sum of radial Gaussians (see
``backend/landuse.py``). On its own that produces smooth blobs that ignore the
shoreline, so demand bleeds onto Elliott Bay and Lake Union. This script bakes a
"how much city is actually here" weight from the building footprints we already
have, at twice the heatmap grid's resolution (~125 m), which is fine enough
that open water reads as exactly zero.

The weight is gross floor area: ``footprint_area * storeys``, summed per subcell
and normalized against the 99th percentile of the non-empty subcells. The
percentile rather than the max matters -- a single outlier bin (the convention
center) otherwise drags the whole downtown down to a fifth of full scale.

One generator, one schema, two destinations: the backend reads the copy under
``seattle/data/processed/`` and the frontend fetches the one under ``public/``,
so the two can never disagree about where the city is.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.grid import Grid, load_grid  # noqa: E402

# Metres of building height per storey. Only used to turn a height into a floor
# count, so the exact value matters far less than being consistent.
METRES_PER_STOREY = 3.5

# Height assumed for the handful of footprints the shell join left without one.
# Dropping them instead would punch holes in otherwise solid residential blocks.
DEFAULT_HEIGHT_M = 4.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the heatmap built-mass field from Seattle building footprints."
    )
    parser.add_argument(
        "--join-csv",
        default="../data/processed/seattle_building_height_join.csv",
        help="Joined height CSV path relative to seattle/scripts/.",
    )
    parser.add_argument(
        "--grid-geojson",
        default="../data/processed/seattle_heatmap_grid_250m.geojson",
        help="Heatmap grid GeoJSON path relative to seattle/scripts/.",
    )
    parser.add_argument(
        "--out-json",
        default="../data/processed/seattle_heatmap_built_mass.json",
        help="Canonical output path relative to seattle/scripts/ (read by the backend).",
    )
    parser.add_argument(
        "--public-json",
        default="../../public/seattle/seattle-built-mass.json",
        help="Frontend copy path relative to seattle/scripts/. Pass '' to skip.",
    )
    parser.add_argument(
        "--sub",
        type=int,
        default=2,
        help="Subdivisions per grid cell per axis. Must match HEATMAP_SUBDIVISIONS.",
    )
    parser.add_argument(
        "--percentile",
        type=float,
        default=99.0,
        help="Percentile of non-empty subcells that normalizes to 1.0.",
    )
    return parser.parse_args()


def accumulate_built_mass(join_csv: Path, grid: Grid, sub: int) -> tuple[list[float], dict]:
    """Sum gross floor area into a ``sub``x-finer grid than ``grid``."""
    rows, cols = grid.rows * sub, grid.cols * sub
    bounds = grid.bounds
    sub_w = (bounds.east - bounds.west) / cols
    sub_h = (bounds.north - bounds.south) / rows

    weights = [0.0] * (rows * cols)
    binned = 0
    outside = 0
    unparseable = 0
    heights_defaulted = 0

    with join_csv.open() as handle:
        for row in csv.DictReader(handle, restval=""):
            try:
                lon = float(row["footprint_centroid_lon"])
                lat = float(row["footprint_centroid_lat"])
                area = float(row["footprint_area"])
            except (KeyError, TypeError, ValueError):
                unparseable += 1
                continue

            if area <= 0.0 or math.isnan(lon) or math.isnan(lat) or math.isnan(area):
                unparseable += 1
                continue

            try:
                height_m = float(row.get("building_height_m", ""))
            except ValueError:
                height_m = math.nan
            if math.isnan(height_m) or height_m <= 0.0:
                height_m = DEFAULT_HEIGHT_M
                heights_defaulted += 1

            # Row 0 is the north edge, matching the wire contract and the
            # frontend's frameToGeoJSON.
            col = int((lon - bounds.west) // sub_w)
            row_idx = int((bounds.north - lat) // sub_h)
            if not (0 <= row_idx < rows and 0 <= col < cols):
                outside += 1
                continue

            weights[row_idx * cols + col] += area * max(1.0, height_m / METRES_PER_STOREY)
            binned += 1

    stats = {
        "buildings_binned": binned,
        "buildings_outside_grid": outside,
        "rows_unparseable": unparseable,
        "heights_defaulted": heights_defaulted,
    }
    return weights, stats


def normalize(weights: list[float], percentile: float) -> tuple[list[float], float]:
    """Scale so the given percentile of non-empty subcells lands on 1.0."""
    non_empty = sorted(value for value in weights if value > 0.0)
    if not non_empty:
        raise ValueError("No building mass landed on the grid; check the CSV and bounds.")

    rank = (percentile / 100.0) * (len(non_empty) - 1)
    lower = non_empty[math.floor(rank)]
    upper = non_empty[math.ceil(rank)]
    scale = lower + (upper - lower) * (rank - math.floor(rank))
    if scale <= 0.0:
        scale = non_empty[-1]

    return [round(min(1.0, value / scale), 3) for value in weights], scale


def main() -> None:
    args = parse_args()
    base_dir = Path(__file__).resolve().parent
    join_csv = base_dir / args.join_csv
    grid_geojson = base_dir / args.grid_geojson
    out_json = (base_dir / args.out_json).resolve()

    if args.sub < 1:
        raise SystemExit("--sub must be at least 1")

    grid = load_grid(grid_geojson)
    raw, stats = accumulate_built_mass(join_csv, grid, args.sub)
    weights, scale = normalize(raw, args.percentile)

    payload = {
        "rows": grid.rows,
        "cols": grid.cols,
        "sub": args.sub,
        "bounds": grid.bounds.to_dict(),
        "weights": weights,
    }
    serialized = json.dumps(payload, separators=(",", ":"))

    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(serialized)

    written = [str(out_json)]
    if args.public_json:
        public_json = (base_dir / args.public_json).resolve()
        public_json.parent.mkdir(parents=True, exist_ok=True)
        public_json.write_text(serialized)
        written.append(str(public_json))

    print(
        json.dumps(
            {
                "written": written,
                "grid": {"rows": grid.rows, "cols": grid.cols, "sub": args.sub},
                "subcells": len(weights),
                "subcells_non_empty": sum(1 for value in weights if value > 0.0),
                "normalizing_floor_area_m2": round(scale, 1),
                "percentile": args.percentile,
                **stats,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

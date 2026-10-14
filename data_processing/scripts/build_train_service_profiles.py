#!/usr/bin/env python3
"""Generate the frontend train animation service artifact."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from src.common.train_service_profiles import build_artifact


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build train service animation profiles.")
    parser.add_argument(
        "--rail-gtfs-zip",
        default="curr_data/raw/40_gtfs.zip",
        help="Official Sound Transit rail GTFS zip (40_gtfs.zip).",
    )
    parser.add_argument(
        "--track-geometry-ts",
        default="../src/stops/track_geometry.ts",
        help="Frontend generated track geometry module.",
    )
    parser.add_argument(
        "--output-json",
        default="../public/seattle/train-service.json",
        help="Shared frontend/backend service JSON.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rail_gtfs_zip = (ROOT_DIR / args.rail_gtfs_zip).resolve()
    track_geometry_ts = (ROOT_DIR / args.track_geometry_ts).resolve()
    output_json = (ROOT_DIR / args.output_json).resolve()

    if not rail_gtfs_zip.exists():
        raise FileNotFoundError(
            f"Missing rail GTFS zip at {rail_gtfs_zip}. Download {rail_gtfs_zip.name} from "
            "https://www.soundtransit.org/GTFS-rail/40_gtfs.zip first."
        )

    artifact = build_artifact(rail_gtfs_zip=rail_gtfs_zip, track_geometry_path=track_geometry_ts)
    artifact["version"] = 1
    sys.path.insert(0, str(ROOT_DIR.parent))
    from backend.service import validate_artifact
    validate_artifact(artifact)
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(artifact, separators=(",", ":")) + "\n")
    print(f"Wrote {output_json}")


if __name__ == "__main__":
    main()

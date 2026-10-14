from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
REGIONS = ("downtown-core", "east-neighborhoods", "northwest-seattle", "west-seattle", "beacon-hill")
VERSION = "2.79.0"


def tile_coordinate(lon, lat, zoom):
    scale = 2 ** zoom
    return int((lon + 180) / 360 * scale), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * scale)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tippecanoe", default=os.environ.get("TIPPECANOE", "tippecanoe"))
    args = parser.parse_args()
    version = subprocess.check_output([args.tippecanoe, "--version"], stderr=subprocess.STDOUT, text=True).strip()
    if version != f"tippecanoe v{VERSION}":
        raise ValueError(f"Expected Tippecanoe {VERSION}, got {version}")
    features = {}
    for region in REGIONS:
        payload = json.loads((ROOT / f"public/seattle/seattle-buildings-{region}.geojson").read_text())
        for feature in payload["features"]:
            properties = feature["properties"]
            identity = int(properties["OBJECTID"])
            height = float(properties.get("height_m") or 0)
            if not math.isfinite(height) or height < 0:
                raise ValueError(f"Invalid building height: {identity}")
            value = {"type": "Feature", "id": identity, "properties": {"OBJECTID": identity, "height_m": height}, "geometry": feature["geometry"]}
            if identity in features and features[identity] != value:
                raise ValueError(f"Conflicting duplicate building: {identity}")
            features[identity] = value
    data = "\n".join(json.dumps(features[key], separators=(",", ":")) for key in sorted(features))
    revision = hashlib.sha256((VERSION + ':8:15:14:drop-smallest:' + data).encode()).hexdigest()[:16]
    root = ROOT / "public/seattle/buildings"
    destination = root / revision
    root.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        with tempfile.TemporaryDirectory() as temporary:
            input_path = Path(temporary) / "buildings.geojsonl"
            input_path.write_text(data)
            output = Path(temporary) / "tiles"
            subprocess.run([args.tippecanoe, "-e", str(output), "-l", "buildings", "-Z8", "-z15", "-d14",
                            "--drop-smallest-as-needed", "--maximum-tile-bytes=500000", "--quiet", str(input_path)], check=True)
            for tile in output.rglob("*.pbf"):
                raw = tile.read_bytes()
                if len(raw) > 500_000:
                    raise ValueError(f"Oversized tile: {tile}")
                gzip.decompress(raw)
            output.rename(destination)
    for zoom in range(8, 16):
        west, north = tile_coordinate(-122.44, 47.70, zoom)
        east, south = tile_coordinate(-122.25, 47.53, zoom)
        for column in range(west, east + 1):
            for row in range(north, south + 1):
                tile = destination / str(zoom) / str(column) / f"{row}.pbf"
                if not tile.exists():
                    tile.parent.mkdir(parents=True, exist_ok=True)
                    tile.write_bytes(gzip.compress(b"", mtime=0))
    files = list(destination.rglob("*.pbf"))
    startup = 0
    zoom = 14
    west, north = tile_coordinate(-122.37, 47.63, zoom)
    east, south = tile_coordinate(-122.30, 47.59, zoom)
    for column in range(west, east + 1):
        for row in range(north, south + 1):
            tile = destination / str(zoom) / str(column) / f"{row}.pbf"
            if tile.exists():
                startup += tile.stat().st_size
    if startup > 5_000_000:
        raise ValueError(f"Startup tiles exceed 5 MB: {startup}")
    manifest = {"tilejson": "3.0.0", "name": "Seattle buildings", "scheme": "xyz", "minzoom": 8, "maxzoom": 15,
                "bounds": [-122.44, 47.53, -122.25, 47.70],
                "tiles": [f"/seattle/buildings/{revision}/{{z}}/{{x}}/{{y}}.pbf"],
                "vector_layers": [{"id": "buildings", "fields": {"OBJECTID": "Number", "height_m": "Number"}}]}
    (root / "tilejson.json").write_text(json.dumps(manifest, indent=2) + "\n")
    report = {"revision": revision, "generator": version, "buildings": len(features), "tiles": len(files),
              "compressedBytes": sum(tile.stat().st_size for tile in files), "startupBytes": startup,
              "maxTileBytes": max(tile.stat().st_size for tile in files)}
    (root / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()

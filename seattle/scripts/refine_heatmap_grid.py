"""Refine the canonical coarse grid without changing its runtime extent."""

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.grid import Grid, load_grid


def refine(grid: Grid) -> dict:
    rows, cols = grid.rows * 2, grid.cols * 2
    width = (grid.bounds.east - grid.bounds.west) / cols
    height = (grid.bounds.north - grid.bounds.south) / rows
    features = []
    for row in range(rows):
        north = grid.bounds.north - row * height
        south = grid.bounds.north - (row + 1) * height
        for col in range(cols):
            west = grid.bounds.west + col * width
            east = grid.bounds.west + (col + 1) * width
            features.append({"type": "Feature", "properties": {"cell_id": f"r{row:03d}_c{col:03d}"},
                             "geometry": {"type": "Polygon", "coordinates": [[
                                 [west, north], [east, north], [east, south], [west, south], [west, north]
                             ]]}})
    return {"type": "FeatureCollection", "features": features}


if __name__ == "__main__":
    directory = ROOT / "seattle/data/processed"
    source = load_grid(directory / "seattle_heatmap_grid.geojson")
    (directory / "seattle_heatmap_grid_250m.geojson").write_text(json.dumps(refine(source), separators=(",", ":")))

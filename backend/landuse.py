"""Seattle land use: who is where.

This module answers one question per grid cell: how many residents, jobs,
students, and daily visitors does it hold? Those four counts are the only
inputs to demand generation (see ``demand.py``).

Land use is authored as a table of ``District`` records carrying real counts.
Each district's totals are spread over nearby cells with a Gaussian weight that
is **normalized to sum to 1**, so population is conserved: the sum of
``residents`` over every cell equals the sum over every district. That makes
per-cell values a genuine density in people-per-cell rather than an arbitrary
score, and it means the numbers below can be checked against public figures.

A Gaussian on its own is a circle, and Seattle is not: an unweighted spread puts
people on Elliott Bay and Lake Union. So each cell's weight is also multiplied by
its **built mass** -- the gross floor area standing there, baked offline by
``seattle/scripts/build_heatmap_built_mass.py``. Cells with no buildings get a
hard zero, and dense cells get more of their district's people than empty ones,
which is what makes the field follow the city instead of a compass rose.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from .geo import haversine_m
from .grid import Grid


@dataclass(frozen=True)
class District:
    """A named chunk of the city and the people it holds.

    ``radius_m`` is the Gaussian scale over which the counts are spread, not a
    hard edge: a cell at ``radius_m`` from the center receives ``e^-1`` of the
    peak weight.
    """

    name: str
    lat: float
    lon: float
    radius_m: float
    residents: int
    jobs: int
    students: int
    visitors: int


@dataclass(frozen=True)
class CellCenter:
    row: int
    col: int
    lat: float
    lon: float


@dataclass
class CellLandUse:
    """People assigned to a single grid cell."""

    residents: float = 0.0
    jobs: float = 0.0
    students: float = 0.0
    visitors: float = 0.0


# Counts are rounded public figures (OFM population estimates, PSRC covered
# employment, university enrollment, visitor draw). They are meant to be
# argued with and edited -- that is the point of stating them in these units.
SEATTLE_DISTRICTS: tuple[District, ...] = (
    District("Downtown office core", 47.6064, -122.3343, 1700, 25_000, 160_000, 3_000, 40_000),
    District("South Lake Union", 47.6244, -122.3385, 1500, 15_000, 60_000, 1_000, 8_000),
    District("First Hill medical", 47.6095, -122.3237, 1150, 18_000, 35_000, 4_000, 6_000),
    District("SODO industrial", 47.5828, -122.3310, 1800, 2_000, 28_000, 0, 3_000),
    District("University District", 47.6614, -122.3148, 1550, 22_000, 12_000, 20_000, 8_000),
    District("UW campus", 47.6540, -122.3076, 1400, 6_000, 20_000, 32_000, 6_000),
    District("Capitol Hill", 47.6230, -122.3197, 1500, 35_000, 18_000, 3_000, 20_000),
    District("Belltown", 47.6144, -122.3458, 1250, 18_000, 22_000, 500, 12_000),
    District("Ballard", 47.6680, -122.3820, 1700, 30_000, 14_000, 1_000, 12_000),
    District("Fremont", 47.6515, -122.3500, 1350, 14_000, 12_000, 500, 7_000),
    District("Seattle Center", 47.6212, -122.3500, 1350, 6_000, 9_000, 1_000, 25_000),
    District("Stadium District", 47.5907, -122.3325, 1650, 3_000, 8_000, 0, 22_000),
    District("Waterfront / Pike Place", 47.6096, -122.3425, 1450, 5_000, 15_000, 0, 35_000),
    District("Alki / West Seattle", 47.5799, -122.4104, 1900, 12_000, 3_000, 0, 9_000),
    District("Green Lake", 47.6802, -122.3344, 1700, 20_000, 5_000, 500, 10_000),
    District("West Seattle Junction", 47.5612, -122.3868, 2100, 34_000, 9_000, 500, 6_000),
    District("Queen Anne", 47.6376, -122.3567, 1700, 28_000, 11_000, 1_000, 5_000),
    District("Wallingford", 47.6592, -122.3360, 1750, 18_000, 6_000, 1_000, 4_000),
    District("Lake City", 47.7192, -122.2950, 2100, 26_000, 7_000, 500, 4_000),
    District("Northgate", 47.7040, -122.3250, 1850, 24_000, 12_000, 2_000, 9_000),
    District("Rainier Valley", 47.5475, -122.2873, 2600, 42_000, 9_000, 1_000, 5_000),
    District("Beacon Hill", 47.5714, -122.3085, 1850, 22_000, 6_000, 500, 3_000),
    District("Central District", 47.6077, -122.3002, 1700, 24_000, 8_000, 1_000, 4_000),
    District("Magnolia", 47.6465, -122.3996, 1850, 15_000, 4_000, 0, 2_000),
)


# How hard built mass shapes the spread. 0.0 disables it and falls back to a
# plain Gaussian; 1.0 weights strictly by floor area, which drains the
# neighborhoods into downtown. Halfway keeps the neighborhoods legible while
# still pinning the field to real buildings.
BUILT_MASS_EXPONENT = 0.5

# Below this share of the normalizing floor area, a cell is not part of the
# city. A 500 m cell that clips a single shoreline building -- Union Bay catching
# the edge of Montlake, Discovery Park catching the ranger station -- otherwise
# reads as inhabited and lights up half a lake. Genuine low-density cells sit an
# order of magnitude above it (Magnolia 0.15, Green Lake's half-lake cell 0.05).
MIN_CELL_BUILT_MASS = 0.01


def load_built_mass(path: str | Path, grid: Grid) -> list[float] | None:
    """Per-cell built-mass weights in ``[0, 1]``, row-major, row 0 north.

    The artifact is authored at ``sub`` times the grid resolution so that open
    water reads as zero even where a 500 m cell straddles a shoreline; this
    averages each cell's ``sub x sub`` block back down to one weight per cell.

    Returns ``None`` when the file is missing, so the backend still boots
    against a bare checkout and falls back to :func:`is_probable_water`.
    """
    path = Path(path)
    if not path.exists():
        return None

    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = int(payload["rows"])
    cols = int(payload["cols"])
    sub = int(payload["sub"])
    weights = payload["weights"]

    if any(abs(payload["bounds"][key] - value) > 1e-9 for key, value in grid.bounds.to_dict().items()):
        raise ValueError("Built-mass bounds do not match the heatmap grid")
    if rows != grid.rows or cols != grid.cols:
        raise ValueError(
            f"Built-mass grid is {rows}x{cols} but the heatmap grid is "
            f"{grid.rows}x{grid.cols}; re-run build_heatmap_built_mass.py"
        )
    if len(weights) != rows * cols * sub * sub:
        raise ValueError(
            f"Built-mass file holds {len(weights)} weights, expected "
            f"{rows * cols * sub * sub} for a {rows}x{cols} grid at sub={sub}"
        )

    sub_cols = cols * sub
    per_cell = float(sub * sub)
    coarse: list[float] = []
    for row in range(rows):
        for col in range(cols):
            total = 0.0
            for sub_row in range(sub):
                start = (row * sub + sub_row) * sub_cols + col * sub
                total += sum(weights[start : start + sub])
            coarse.append(total / per_cell)
    return coarse


def cell_centers(grid: Grid) -> list[CellCenter]:
    """Row-major cell centers matching the wire contract's centroid formula."""
    bounds = grid.bounds
    cell_w = (bounds.east - bounds.west) / grid.cols
    cell_h = (bounds.north - bounds.south) / grid.rows
    centers: list[CellCenter] = []
    for row in range(grid.rows):
        lat = bounds.north - (row + 0.5) * cell_h
        for col in range(grid.cols):
            lon = bounds.west + (col + 0.5) * cell_w
            centers.append(CellCenter(row=row, col=col, lat=lat, lon=lon))
    return centers


def build_land_use(
    centers: list[CellCenter],
    districts: tuple[District, ...] = SEATTLE_DISTRICTS,
    built_mass: list[float] | None = None,
) -> list[CellLandUse]:
    """Spread every district's people over the cells, conserving totals.

    ``built_mass`` is the per-cell weight from :func:`load_built_mass`. When it
    is ``None`` this falls back to the hand-drawn :func:`is_probable_water`
    coastline, which is coarser and misses several water bodies.
    """
    land_use = [CellLandUse() for _ in centers]
    habitability = cell_habitability(centers, built_mass)

    for district in districts:
        weights = [0.0] * len(centers)
        total_weight = 0.0
        for idx, center in enumerate(centers):
            if habitability[idx] <= 0.0:
                continue
            distance_m = haversine_m(center.lat, center.lon, district.lat, district.lon)
            weight = math.exp(-((distance_m / district.radius_m) ** 2)) * habitability[idx]
            weights[idx] = weight
            total_weight += weight

        if total_weight <= 0.0:
            continue

        for idx, weight in enumerate(weights):
            if weight <= 0.0:
                continue
            share = weight / total_weight
            cell = land_use[idx]
            cell.residents += district.residents * share
            cell.jobs += district.jobs * share
            cell.students += district.students * share
            cell.visitors += district.visitors * share

    return land_use


def cell_habitability(
    centers: list[CellCenter],
    built_mass: list[float] | None,
) -> list[float]:
    """Per-cell multiplier for "can anyone plausibly be here".

    Zero means nobody, ever -- open water, or a cell with no buildings at all.
    This is the one place the water question is answered, so overlays, walksheds
    and frame composition all agree with land use about where the city is.
    """
    if built_mass is None:
        return [0.0 if is_probable_water(c.lat, c.lon) else 1.0 for c in centers]
    if len(built_mass) != len(centers):
        raise ValueError(
            f"Built-mass has {len(built_mass)} cells but the grid has {len(centers)}"
        )
    return [
        0.0 if mass < MIN_CELL_BUILT_MASS else mass**BUILT_MASS_EXPONENT
        for mass in built_mass
    ]


# ---------------------------------------------------------------------------
# Water masking: nobody lives on Puget Sound.
#
# Fallback only -- used when the built-mass artifact is absent. It is a
# hand-drawn approximation and knowingly misses Portage Bay, Union Bay, Green
# Lake, the Ship Canal and the Duwamish.
# ---------------------------------------------------------------------------

_PUGET_COAST = (
    (47.74, -122.42),
    (47.69, -122.41),
    (47.67, -122.40),
    (47.645, -122.41),
    (47.635, -122.39),
    (47.625, -122.37),
    (47.615, -122.355),
    (47.605, -122.347),
    (47.595, -122.347),
    (47.58, -122.36),
    (47.565, -122.375),
    (47.55, -122.39),
    (47.50, -122.40),
)

_LAKE_WA_COAST = (
    (47.70, -122.255),
    (47.68, -122.260),
    (47.66, -122.262),
    (47.645, -122.270),
    (47.635, -122.275),
    (47.62, -122.272),
    (47.60, -122.270),
    (47.58, -122.268),
    (47.56, -122.262),
    (47.50, -122.255),
)


def _interp_lon(lat: float, waypoints: tuple[tuple[float, float], ...]) -> float:
    if lat >= waypoints[0][0]:
        return waypoints[0][1]
    if lat <= waypoints[-1][0]:
        return waypoints[-1][1]
    for idx in range(len(waypoints) - 1):
        lat_a, lon_a = waypoints[idx]
        lat_b, lon_b = waypoints[idx + 1]
        if lat_b <= lat <= lat_a:
            t = (lat - lat_b) / (lat_a - lat_b)
            return lon_b + t * (lon_a - lon_b)
    return waypoints[-1][1]


def is_probable_water(lat: float, lon: float) -> bool:
    if lon < _interp_lon(lat, _PUGET_COAST):
        return True
    if 47.628 < lat < 47.646 and -122.344 < lon < -122.328:
        return True
    return 47.52 < lat < 47.70 and lon > _interp_lon(lat, _LAKE_WA_COAST)

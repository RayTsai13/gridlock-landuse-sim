"""Frame composition: demand, minus what transit absorbs, is what you see."""

from __future__ import annotations

import time
from dataclasses import dataclass

from .demand import DemandField
from .geo import clamp
from .network import ServiceCapacity
from .overlays import LiveOverlayManager
from .sim_time import SimTime


# Unmet trips/hour in a single cell that reads as full saturation on the map.
# This is the physical calibration: it fixes what "1.0" means, and it does not
# move between frames, so building transit visibly cools the city instead of
# being renormalized away.
#
# Raised from 2400 when land use began following built mass (see
# ``landuse.BUILT_MASS_EXPONENT``). Weighting each district's people by the floor
# area actually standing there concentrates them into fewer, denser cells, which
# lifted peak unmet demand downtown by about half. At the old value a dozen
# downtown cells sat pinned at 1.0 through the middle of the day, so dropping a
# crowd there changed nothing visible -- the map had no headroom left to show it.
MAX_UNMET_TRIPS_PER_CELL_HOUR = 3600.0

# Cosmetic shaping only. 1.0 is linear; lower values lift the midtones if the
# map reads too dark. Adjust this, not MAX_UNMET_TRIPS_PER_CELL_HOUR, for looks.
DENSITY_GAMMA = 0.85

# Cells at or below this display density are omitted from the frame. Set high
# enough that the tail of near-invisible cells never ships: the frontend blurs
# and interpolates whatever it receives, so a few hundred cells at 0.02 arrive
# as a wash of haze over the whole viewport rather than as faint specks.
DISPLAY_THRESHOLD = 0.03


@dataclass
class HeatmapFrame:
    timestamp: float
    state_version: str
    sim_time: SimTime
    cells: list[list[int | float]]
    cell_metrics: list[list[int | float]]
    totals: dict[str, float]
    model: dict[str, object]

    def to_dict(self) -> dict[str, object]:
        return {
            "timestamp": self.timestamp,
            "state_version": self.state_version,
            "sim_time": self.sim_time.to_dict(),
            "cells": self.cells,
            "cell_metrics": self.cell_metrics,
            "totals": self.totals,
            "model": self.model,
        }


class FrameComposer:
    def __init__(
        self,
        *,
        cols: int,
        max_unmet_trips: float = MAX_UNMET_TRIPS_PER_CELL_HOUR,
        gamma: float = DENSITY_GAMMA,
        display_threshold: float = DISPLAY_THRESHOLD,
        habitability: list[float] | None = None,
    ) -> None:
        self.cols = cols
        self.max_unmet_trips = max_unmet_trips
        self.gamma = gamma
        self.display_threshold = display_threshold
        # The last word on where the city is. Land use, overlays and walksheds
        # all honour this already; checking it once more at emit time is what
        # makes "no cell over water ever ships" a property of the wire format
        # rather than of every upstream path staying correct.
        self.habitability = habitability

    def compose(
        self,
        *,
        sim_time: SimTime,
        state_version: str,
        demand_field: DemandField,
        service: ServiceCapacity,
        overlays: LiveOverlayManager,
    ) -> HeatmapFrame:
        base = demand_field.trips_per_hour(sim_time)
        crowds = overlays.trips_per_hour(sim_time)
        demand = [b + c for b, c in zip(base, crowds)]

        served = service.allocate(demand, sim_time=sim_time)
        unmet = [max(0.0, d - s) for d, s in zip(demand, served)]

        return HeatmapFrame(
            timestamp=time.time(),
            state_version=state_version,
            sim_time=sim_time,
            cells=self._to_sparse_cells(unmet),
            cell_metrics=[[idx // self.cols, idx % self.cols, value, served[idx], unmet[idx]]
                          for idx, value in enumerate(demand) if value > 0],
            totals={"generated": sum(demand), "served": sum(served), "unmet": sum(unmet)},
            model={"synthetic": False, **service.metadata},
        )

    def _to_sparse_cells(self, unmet: list[float]) -> list[list[int | float]]:
        cells: list[list[int | float]] = []
        habitability = self.habitability
        for idx, trips in enumerate(unmet):
            if habitability is not None and habitability[idx] <= 0.0:
                continue
            density = clamp(trips / self.max_unmet_trips) ** self.gamma
            if density <= self.display_threshold:
                continue
            cells.append([idx // self.cols, idx % self.cols, round(density, 3)])
        return cells

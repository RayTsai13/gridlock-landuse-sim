"""Process-wide simulation state for the interactive heatmap backend."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

from .composer import FrameComposer
from .demand import DemandField
from .grid import Grid
from .landuse import build_land_use, cell_centers, cell_habitability, load_built_mass
from .network import (
    DEFAULT_SCENARIO_ID,
    VALID_SCENARIO_IDS,
    ActiveNetwork,
    ServiceCapacity,
    default_network_for_scenario,
    parse_network_payload,
)
from .protocol import validate_network_size
from .service import validate_network_service
from .overlays import CrowdOverlay, LiveOverlayManager
from .sim_time import PlaybackController


# Anchored to the repository root, not the working directory, so tests and the
# server resolve it identically. Absent is fine: land use falls back to the
# hand-drawn coastline in ``landuse.is_probable_water``.
DEFAULT_BUILT_MASS_PATH = (
    Path(__file__).resolve().parent.parent
    / "seattle"
    / "data"
    / "processed"
    / "seattle_heatmap_built_mass.json"
)


class State:
    """Single-process simulation state shared by all SSE connections.

    The simulation clock is advanced by exactly one producer (the frame ticker
    in ``server.py``), never by a connection. Connections are pure readers of
    :meth:`current_frame`, which is composed once per tick and shared, so N
    connected clients cost the same as one.
    """

    def __init__(
        self,
        grid: Grid,
        *,
        frame_interval_seconds: float = 1.0,
        sim_step_seconds: int = 1800,
        built_mass_path: str | Path | None = DEFAULT_BUILT_MASS_PATH,
        shared: State | None = None,
    ) -> None:
        self.grid = grid
        self.centers = shared.centers if shared else cell_centers(grid)
        self.built_mass = shared.built_mass if shared else (
            None if built_mass_path is None else load_built_mass(built_mass_path, grid)
        )
        # Computed once and shared by every consumer, so land use, crowds,
        # walksheds and frame composition cannot disagree about where the city
        # is -- the bug that let a red blob sit on Elliott Bay.
        self.habitability = shared.habitability if shared else cell_habitability(self.centers, self.built_mass)
        self.land_use = shared.land_use if shared else build_land_use(self.centers, built_mass=self.built_mass)
        self.demand_field = DemandField(self.land_use)
        self.composer = FrameComposer(cols=grid.cols, habitability=self.habitability)
        self.playback = PlaybackController(
            frame_interval_seconds=frame_interval_seconds,
            sim_step_seconds=sim_step_seconds,
        )
        self.scenario_id: str = DEFAULT_SCENARIO_ID
        self.active_network: ActiveNetwork = default_network_for_scenario(self.scenario_id)
        self.service = ServiceCapacity(
            grid,
            self.active_network,
            centers=self.centers,
            habitability=self.habitability,
        )
        self.overlays = LiveOverlayManager(self.centers, self.habitability)
        self.people = self.overlays.people
        self.scenario_revision: int = 0
        self._version: int = 0
        self._state_counter: int = 0
        self._cond: asyncio.Condition | None = None
        self._latest_frame: dict[str, object] | None = None
        self._subscribers: int = 0
        self._encoded_frame: str | None = None
        self.composition_seconds = 0.0

    @property
    def version(self) -> int:
        return self._version

    @property
    def state_version(self) -> str:
        return f"state_v{self._state_counter}"

    # -- Subscribers ------------------------------------------------------

    @property
    def subscriber_count(self) -> int:
        return self._subscribers

    def add_subscriber(self) -> None:
        self._subscribers += 1

    def remove_subscriber(self) -> None:
        self._subscribers = max(0, self._subscribers - 1)

    # -- Change notification ----------------------------------------------

    def _ensure_cond(self) -> asyncio.Condition:
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    async def notify_change(self) -> None:
        self._version += 1
        cond = self._ensure_cond()
        async with cond:
            cond.notify_all()

    async def wait_for_change(self, last_version: int, timeout: float) -> int:
        cond = self._ensure_cond()
        async with cond:
            try:
                await asyncio.wait_for(
                    cond.wait_for(lambda: self._version > last_version),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                pass
        return self._version

    # -- Mutations ---------------------------------------------------------

    def scenario_payload(self):
        return {
            "scenario_id": self.scenario_id,
            "stops": [{"id": stop.id, "name": stop.name, "coordinates": [stop.lon, stop.lat]} for stop in self.active_network.stops],
            "lines": [{"id": line.id, "name": line.name, "stopIds": list(line.stop_ids), "path": list(line.path)} for line in self.active_network.lines],
        }

    def set_scenario(
        self,
        scenario_id: str,
        *,
        stops: Any = None,
        lines: Any = None,
    ) -> None:
        if scenario_id not in VALID_SCENARIO_IDS:
            raise ValueError(f"Unknown scenario_id: {scenario_id!r}")
        validate_network_size(stops, lines)
        network = parse_network_payload(
            scenario_id=scenario_id,
            stops_payload=stops,
            lines_payload=lines,
        )
        validate_network_service(network)
        if network != self.active_network:
            self.service = ServiceCapacity(
                self.grid, network, centers=self.centers, habitability=self.habitability,
            )
        self.scenario_id = scenario_id
        self.active_network = network
        self.scenario_revision += 1
        self._state_counter += 1
        self.invalidate_frame()

    def add_person(
        self,
        *,
        lat: float,
        lon: float,
        count: int,
        kind: str | None = None,
        duration_minutes: int | None = None,
        radius_m: float | None = None,
        decay_m: float | None = None,
    ) -> CrowdOverlay:
        bounds = self.grid.bounds
        in_bounds = (
            bounds.west <= lon <= bounds.east
            and bounds.south <= lat <= bounds.north
        )
        if not in_bounds:
            raise ValueError("lat/lon outside configured grid bounds")
        overlay = self.overlays.add(
            lat=lat,
            lon=lon,
            count=count,
            sim_time=self.playback.current_time,
            kind=kind,
            duration_minutes=duration_minutes,
            radius_m=radius_m,
            decay_m=decay_m,
        )
        self._state_counter += 1
        self.invalidate_frame()
        return overlay

    def add_people_batch(self, entries: list[dict]) -> list[CrowdOverlay]:
        # Build every footprint before publishing any part of the mutation.
        staged = LiveOverlayManager(self.centers, self.habitability)
        people = [staged.add(**entry, sim_time=self.playback.current_time) for entry in entries]
        self.people.update(staged.people)
        self._state_counter += 1
        self.invalidate_frame()
        return people

    def remove_person(self, person_id: str) -> None:
        self.overlays.remove(person_id)
        self._state_counter += 1
        self.invalidate_frame()

    def clear_people(self) -> None:
        if self.people:
            self._state_counter += 1
        self.overlays.clear()
        self.invalidate_frame()

    # -- Playback ----------------------------------------------------------

    def playback_state(self) -> dict[str, object]:
        return self.playback.to_dict()

    def set_playback(
        self,
        *,
        is_playing: bool | None = None,
        sim_minutes_per_second: float | None = None,
    ) -> None:
        if is_playing is not None:
            self.playback.set_playing(is_playing)
        if sim_minutes_per_second is not None:
            self.playback.set_speed(sim_minutes_per_second)
        self.invalidate_frame()

    def seek_playback(
        self,
        *,
        minute_of_week: int | None = None,
        day_of_week: int | None = None,
        time_bin: int | None = None,
    ) -> None:
        self.playback.seek(
            minute_of_week=minute_of_week,
            day_of_week=day_of_week,
            time_bin=time_bin,
        )
        self.invalidate_frame()

    def advance_playback(self) -> None:
        self.playback.advance()
        self.invalidate_frame()

    def tick(self) -> None:
        """Advance the clock one frame and refresh the shared frame.

        This is the *only* place the simulation clock moves. Called once per
        interval by the frame ticker, never by a connection.
        """
        if not self.playback.is_playing:
            return
        self.playback.advance()
        self.invalidate_frame()
        self.current_frame()

    # -- Frames -------------------------------------------------------------

    def invalidate_frame(self) -> None:
        self._latest_frame = None
        self._encoded_frame = None

    def encoded_frame(self) -> str:
        if self._encoded_frame is None:
            self._encoded_frame = json.dumps(self.current_frame(), separators=(",", ":"))
        return self._encoded_frame

    def current_frame(self) -> dict[str, object]:
        """The frame every connection shares, composed at most once per change."""
        if self._latest_frame is None:
            started = time.perf_counter()
            self._latest_frame = self.compose_frame()
            self.composition_seconds = time.perf_counter() - started
        return self._latest_frame

    def compose_frame(self) -> dict[str, object]:
        return self.composer.compose(
            sim_time=self.playback.current_time,
            state_version=self.state_version,
            demand_field=self.demand_field,
            service=self.service,
            overlays=self.overlays,
        ).to_dict()

    def compose_frame_cells(self) -> list[list[int | float]]:
        return self.compose_frame()["cells"]  # type: ignore[return-value]

"""Shared request limits for the real and synthetic heatmap servers."""

import math
from typing import Any

MAX_PEOPLE = 512
MAX_BATCH = 64
MAX_STOPS = 256
MAX_LINES = 64


def parse_person(payload: dict[str, Any], bounds: dict[str, float]) -> dict[str, Any]:
    lat, lon = float(payload["lat"]), float(payload["lon"])
    if not (bounds["south"] <= lat <= bounds["north"] and
            bounds["west"] <= lon <= bounds["east"]):
        raise ValueError("lat/lon outside configured grid bounds")
    count = int(payload.get("count", 1))
    if not 1 <= count <= 1_000_000:
        raise ValueError("count must be between 1 and 1000000")
    result: dict[str, Any] = {"lat": lat, "lon": lon, "count": count}
    if "kind" in payload:
        result["kind"] = str(payload["kind"])
    for key, limit in (("duration_minutes", 10080), ("radius_m", 10000), ("decay_m", 10000)):
        if key not in payload:
            continue
        value = float(payload[key])
        if not math.isfinite(value) or not 0 < value <= limit:
            raise ValueError(f"{key} must be positive and at most {limit}")
        result[key] = int(value) if key == "duration_minutes" else value
    return result


def parse_batch(payload: dict[str, Any], bounds: dict[str, float], current_count: int):
    entries = payload.get("people")
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_BATCH:
        raise ValueError(f"people must contain 1 to {MAX_BATCH} entries")
    if current_count + len(entries) > MAX_PEOPLE:
        raise ValueError(f"at most {MAX_PEOPLE} active crowds are supported")
    if not all(isinstance(entry, dict) for entry in entries):
        raise ValueError("each person must be an object")
    return [parse_person(entry, bounds) for entry in entries]


def validate_network_size(stops, lines):
    for name, entries, limit in (("stops", stops, MAX_STOPS), ("lines", lines, MAX_LINES)):
        if isinstance(entries, list) and len(entries) > limit:
            raise ValueError(f"{name} must be a list with at most {limit} entries")
    for line in lines if isinstance(lines, list) else []:
        if not isinstance(line, dict):
            continue  # Existing parser tolerates malformed optional network data.
        for key, limit in (("stopIds", MAX_STOPS), ("path", 10000)):
            value = line.get(key)
            if isinstance(value, list) and len(value) > limit:
                raise ValueError("line has too many stops or path coordinates")

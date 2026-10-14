from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path


SERVICE_PATH = Path(__file__).resolve().parents[1] / "public/seattle/train-service.json"
EFFECTIVE_TRIPS_PER_DEPARTURE = 200.0


def validate_artifact(artifact):
    if artifact.get("version") != 1:
        raise ValueError("Unsupported train-service artifact version")
    expected = {(line, day) for line in ("link-1-line", "link-2-line", "ballard-line")
                for day in ("weekday", "saturday", "sunday")}
    paths = artifact.get("paths", {})
    profiles = artifact["lineProfiles"]
    if {(profile["lineId"], profile["dayType"]) for profile in profiles} != expected or len(profiles) != len(expected):
        raise ValueError("Missing or duplicate service day profiles")
    for profile in profiles:
        if {direction["directionId"] for direction in profile["directionProfiles"]} != {0, 1}:
            raise ValueError("Both train directions are required")
        for direction in profile["directionProfiles"]:
            path = paths.get(profile["lineId"], [])
            if len(path) < 2 or len(direction["pathCumulativeMeters"]) != len(path):
                raise ValueError("Service path geometry mismatch")
            stops = direction["stopIds"]
            segments = direction["segmentRuntimeMinutes"]
            if len(segments) != len(stops) - 1 or len(direction["stopDistanceMeters"]) != len(stops):
                raise ValueError("Service stop geometry mismatch")
            if any(not math.isfinite(value) or value <= 0 for value in segments):
                raise ValueError("Invalid service runtime")
            if stops[0] != direction["displayStartStopId"] or stops[-1] != direction["displayEndStopId"]:
                raise ValueError("Service stop ordering mismatch")
            last_end = -1
            for window in direction["serviceWindows"]:
                if not all(math.isfinite(value) for value in window.values()):
                    raise ValueError("Nonfinite service window")
                if window["headwayMinutes"] <= 0 or window["offsetMinutes"] < 0 or not last_end <= window["startMinute"] < window["endMinute"]:
                    raise ValueError("Invalid service window")
                last_end = window["endMinute"]
    return artifact


@lru_cache(maxsize=1)
def load_service():
    return validate_artifact(json.loads(SERVICE_PATH.read_text()))


def day_type(day):
    return "sunday" if day % 7 == 0 else "saturday" if day % 7 == 6 else "weekday"


@lru_cache(maxsize=512)
def departures_by_stop(minute_of_week: int):
    artifact = load_service()
    result = {}
    dwell = artifact["metadata"]["defaultDwellSeconds"] / 60
    for day in range(math.floor((minute_of_week - 2880) / 1440), math.floor((minute_of_week + 60) / 1440) + 1):
        for profile in artifact["lineProfiles"]:
            if profile["dayType"] != day_type(day):
                continue
            for direction in profile["directionProfiles"]:
                elapsed = 0.0
                for index, stop_id in enumerate(direction["stopIds"]):
                    if index:
                        elapsed += direction["segmentRuntimeMinutes"][index - 1]
                        if index > 1:
                            elapsed += dwell
                    count = 0
                    for window in direction["serviceWindows"]:
                        headway = window["headwayMinutes"]
                        first = day * 1440 + window["startMinute"] + min(window["offsetMinutes"], max(0, headway - 0.001))
                        end = day * 1440 + window["endMinute"]
                        lower = max(0, math.ceil((minute_of_week - elapsed - first) / headway))
                        upper = math.ceil((min(end, minute_of_week + 60 - elapsed) - first) / headway)
                        count += max(0, upper - lower)
                    key = (profile["lineId"], stop_id)
                    result[key] = result.get(key, 0) + count
    return result

def validate_network_service(network):
    available = {}
    for profile in load_service()["lineProfiles"]:
        available.setdefault(profile["lineId"], set()).update(
            stop_id for direction in profile["directionProfiles"] for stop_id in direction["stopIds"]
        )
    for line in network.lines:
        if line.id not in available or not set(line.stop_ids) <= available[line.id]:
            raise ValueError(f"No service profile for line or stops: {line.id}")

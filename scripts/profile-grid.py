"""Measure independent active sessions, including composition and JSON encoding."""

import json
from pathlib import Path
import statistics
import sys
import time

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))

from backend.server import GRID
from backend.state import State

report = {'rows': GRID.rows, 'cols': GRID.cols, 'loads': []}
shared = State(GRID)
for count in (1, 10, 100):
    sessions = [State(GRID, shared=shared) for _ in range(count)]
    for state in sessions:
        state.seek_playback(day_of_week=0, time_bin=720)
        state.add_person(lat=47.6064, lon=-122.3343, count=5000, duration_minutes=240)
    elapsed = []
    composition = []
    for iteration in range(12):
        started = time.perf_counter()
        for state in sessions:
            state.seek_playback(day_of_week=0, time_bin=720 + iteration)
            state.encoded_frame()
        elapsed.append((time.perf_counter() - started) * 1000)
        composition.append(sum(state.composition_seconds for state in sessions) * 1000)
    report['loads'].append({'sessions': count, 'median_tick_ms': statistics.median(elapsed),
                            'max_tick_ms': max(elapsed), 'median_composition_ms': statistics.median(composition),
                            'frame_bytes': len(sessions[0].encoded_frame().encode()),
                            'within_one_second': max(elapsed) < 1000})
print(json.dumps(report, indent=2))

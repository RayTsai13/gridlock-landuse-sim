import json
from pathlib import Path

import pytest

from backend.composer import FrameComposer, saturation_for_grid
from backend.grid import load_grid
from backend.landuse import load_built_mass
from backend.state import State
from backend.overlays import CROWD_TRIPS_PER_PERSON_PER_HOUR
from seattle.scripts.refine_heatmap_grid import refine


DIRECTORY = Path('seattle/data/processed')


def test_refinement_preserves_extent_and_sampling():
    coarse = load_grid(DIRECTORY / 'seattle_heatmap_grid.geojson')
    fine = load_grid(DIRECTORY / 'seattle_heatmap_grid_250m.geojson')
    assert (fine.rows, fine.cols) == (112, 70)
    assert fine.bounds.to_dict() == pytest.approx(coarse.bounds.to_dict())
    assert json.loads((DIRECTORY / 'seattle_heatmap_grid_250m.geojson').read_text()) == refine(coarse)
    mask = json.loads((DIRECTORY / 'seattle_heatmap_built_mass.json').read_text())
    assert mask['sub'] == 2
    assert len(mask['weights']) == 31360
    assert json.loads(Path('public/seattle/seattle-built-mass.json').read_text()) == mask
    assert len(load_built_mass(DIRECTORY / 'seattle_heatmap_built_mass.json', fine)) == 7840
    assert saturation_for_grid(fine) == pytest.approx(900)
    original = FrameComposer(cols=coarse.cols, max_unmet_trips=saturation_for_grid(coarse))
    refined = FrameComposer(cols=fine.cols, max_unmet_trips=saturation_for_grid(fine))
    assert original._to_sparse_cells([1800])[0][2] == refined._to_sparse_cells([450])[0][2]


def test_bounds_mismatch_rejected(tmp_path):
    grid = load_grid(DIRECTORY / 'seattle_heatmap_grid_250m.geojson')
    payload = json.loads((DIRECTORY / 'seattle_heatmap_built_mass.json').read_text())
    payload['bounds']['west'] += 0.01
    path = tmp_path / 'mask.json'
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match='bounds'):
        load_built_mass(path, grid)


def test_fine_grid_crowd_and_demand_conservation():
    grid = load_grid(DIRECTORY / 'seattle_heatmap_grid_250m.geojson')
    state = State(grid)
    state.seek_playback(day_of_week=0, time_bin=720)
    before = state.current_frame()['totals']['generated']
    state.add_person(lat=47.6064, lon=-122.3343, count=5000)
    frame = state.current_frame()
    assert frame['totals']['generated'] - before == pytest.approx(5000 * CROWD_TRIPS_PER_PERSON_PER_HOUR)
    assert frame['totals']['generated'] == pytest.approx(frame['totals']['served'] + frame['totals']['unmet'])
    for row, col, generated, served, unmet in frame['cell_metrics']:
        assert 0 <= row < 112 and 0 <= col < 70
        assert min(generated, served, unmet) >= 0

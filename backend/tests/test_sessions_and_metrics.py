import asyncio
import copy

import pytest
from fastapi.testclient import TestClient

from backend import server
from backend.sessions import COOKIE_NAME, SessionRegistry, current_state
from backend.service import departures_by_stop, load_service, validate_artifact
from backend.state import State
from mock import server as mock_server


@pytest.mark.parametrize('module', [server, mock_server])
def test_private_sessions_resume_and_expire(module):
    module.SESSIONS.sessions.clear()
    with TestClient(module.app) as client:
        assert client.get('/api/playback').status_code == 401
        assert client.post('/api/session').json() == {'created': True, 'reset': False}
        first = client.cookies.get(COOKIE_NAME)
        client.post('/api/scenario', json={'scenario_id': 'line-1-2-ballard'})
        client.post('/api/playback', json={'is_playing': False})
        client.post('/api/playback/seek', json={'minute_of_week': 2345})
        client.cookies.clear()
        client.post('/api/session')
        second = client.cookies.get(COOKIE_NAME)
        assert second != first
        assert module.SESSIONS.sessions[second].state.scenario_id == 'line-1'
        client.cookies.clear()
        client.cookies.set(COOKIE_NAME, first, domain='testserver.local', path='/api')
        assert client.post('/api/session').json()['created'] is False
        assert client.get('/api/playback').json()['sim_time']['minute_of_week'] == 2345
        module.SESSIONS.sessions[first].touched -= module.SESSIONS.ttl + 1
        assert client.post('/api/people/batch', json={'people': []}).status_code == 401
        assert client.post('/api/session').json()['reset'] is True
        assert client.cookies.get(COOKIE_NAME) != first


def test_registry_capacity_and_active_subscribers():
    registry = SessionRegistry(lambda: State(server.GRID, shared=server.STATE), ttl=1, limit=1)
    key, session = registry.create()
    assert registry.create() is None
    session.state.add_subscriber()
    session.touched -= 2
    registry.cleanup()
    assert key in registry.sessions
    session.state.remove_subscriber()
    session.touched -= 2
    registry.cleanup()
    assert registry.create() is not None


def test_cross_origin_and_secure_cookie():
    server.SESSIONS.sessions.clear()
    with TestClient(server.app, base_url='https://testserver:8443') as client:
        assert client.post('/api/session', headers={'Origin': 'https://unrelated.example'}).status_code == 403
        response = client.post('/api/session', headers={'Origin': 'https://testserver:8443'})
        assert 'Secure' in response.headers['set-cookie']
        assert 'HttpOnly' in response.headers['set-cookie']
        assert 'SameSite=lax' in response.headers['set-cookie']


@pytest.mark.asyncio
async def test_session_ticker_isolates_and_holds_idle_sessions(monkeypatch):
    registry = SessionRegistry(lambda: State(server.GRID, shared=server.STATE, frame_interval_seconds=0.01))
    monkeypatch.setattr(server, 'SESSIONS', registry)
    monkeypatch.setattr(server, 'FRAME_INTERVAL_S', 0.01)
    _, active = registry.create()
    _, idle = registry.create()
    active.state.add_subscriber()
    active.state.add_subscriber()
    start = active.state.playback.current_tick
    idle_start = idle.state.playback.current_tick
    task = asyncio.create_task(server._frame_ticker())
    await asyncio.sleep(0.025)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert active.state.playback.current_tick > start
    assert idle.state.playback.current_tick == idle_start
    assert active.state.centers is idle.state.centers
    assert active.state.land_use is idle.state.land_use
    assert active.state.current_frame() is active.state.current_frame()


def test_metrics_conserve_and_survive_display_filtering():
    state = State(server.GRID, shared=server.STATE)
    state.seek_playback(day_of_week=2, time_bin=720)
    state.composer.display_threshold = 1.0
    frame = state.current_frame()
    assert frame['cells'] == []
    assert frame['cell_metrics']
    totals = frame['totals']
    for _, _, generated, served, unmet in frame['cell_metrics']:
        assert generated == pytest.approx(served + unmet)
        assert 0 <= served <= generated
    assert totals['generated'] == pytest.approx(totals['served'] + totals['unmet'])
    assert sum(cell[4] for cell in frame['cell_metrics']) == pytest.approx(totals['unmet'])


def test_service_validation_rejects_invalid_windows_and_geometry():
    artifact = copy.deepcopy(load_service())
    artifact['lineProfiles'][0]['directionProfiles'][0]['serviceWindows'][0]['headwayMinutes'] = 0
    with pytest.raises(ValueError):
        validate_artifact(artifact)
    artifact = copy.deepcopy(load_service())
    artifact['lineProfiles'][0]['directionProfiles'][0]['segmentRuntimeMinutes'].pop()
    with pytest.raises(ValueError):
        validate_artifact(artifact)


def test_schedule_capacity_changes_and_wraps():
    morning = departures_by_stop(2 * 1440 + 8 * 60)
    overnight = departures_by_stop(2 * 1440 + 3 * 60)
    assert sum(morning.values()) > sum(overnight.values())
    assert morning[('ballard-line', 'ballard')] > 0
    assert departures_by_stop(0) == departures_by_stop(7 * 1440)


@pytest.mark.asyncio
async def test_request_context_keeps_streams_private():
    class Request:
        async def is_disconnected(self):
            return False
    first = State(server.GRID, shared=server.STATE)
    second = State(server.GRID, shared=server.STATE)
    first.set_scenario('line-1-2')
    token = current_state.set(first)
    stream = server._stream(Request())
    await anext(stream)
    event = await anext(stream)
    assert 'line-1-2' in event
    assert first.subscriber_count == 1
    assert second.subscriber_count == 0
    await stream.aclose()
    current_state.reset(token)
    assert first.subscriber_count == 0

def test_overnight_departures_arrive_at_downstream_stops(monkeypatch):
    from backend import service
    artifact = {
        "metadata": {"defaultDwellSeconds": 20},
        "lineProfiles": [{
            "lineId": "test", "dayType": "saturday",
            "directionProfiles": [{
                "stopIds": ["start", "finish"],
                "segmentRuntimeMinutes": [10],
                "serviceWindows": [{"startMinute": 1430, "endMinute": 1440, "headwayMinutes": 5, "offsetMinutes": 0}],
            }],
        }],
    }
    monkeypatch.setattr(service, "load_service", lambda: artifact)
    service.departures_by_stop.cache_clear()
    try:
        values = service.departures_by_stop(0)
        assert values[("test", "start")] == 0
        assert values[("test", "finish")] == 2
        assert service.departures_by_stop(60)[("test", "finish")] == 0
    finally:
        service.departures_by_stop.cache_clear()

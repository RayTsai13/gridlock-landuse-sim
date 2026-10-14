"""FastAPI backend for the visual-first Seattle demand simulation."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from backend.protocol import MAX_PEOPLE, parse_person, parse_batch

from fastapi import FastAPI, HTTPException, Request, Response
from .sessions import SessionMiddleware, SessionRegistry, current_state
from fastapi.responses import StreamingResponse

from .grid import load_grid
from .state import DEFAULT_BUILT_MASS_PATH, State


logger = logging.getLogger(__name__)

# Anchored to the repository root rather than the working directory, so the
# server and the tests start correctly regardless of where they are launched.
_REPO_ROOT = Path(__file__).resolve().parent.parent

GEOJSON_PATH = Path(
    os.environ.get(
        "HEATMAP_GEOJSON",
        str(_REPO_ROOT / "seattle" / "data" / "processed" / "seattle_heatmap_grid.geojson"),
    )
)
BUILT_MASS_PATH = Path(
    os.environ.get("HEATMAP_BUILT_MASS", str(DEFAULT_BUILT_MASS_PATH))
)
FRAME_INTERVAL_S = float(os.environ.get("HEATMAP_FRAME_INTERVAL", "1.0"))
SIM_STEP_SECONDS = int(os.environ.get("HEATMAP_SIM_STEP_SECONDS", "1800"))


async def _frame_ticker() -> None:
    """Advance the simulation clock and compose the shared frame.

    This is the single producer. Connections never advance the clock, so the
    sim runs at the same rate whether one client is watching or twenty. When
    nobody is connected the clock holds rather than composing frames for an
    empty room.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time()
    while True:
        deadline += FRAME_INTERVAL_S
        await asyncio.sleep(max(0, deadline - loop.time()))
        # Skip missed deadlines instead of bursting ticks after a long stall.
        deadline = max(deadline, loop.time())
        try:
            SESSIONS.cleanup()
            for state in [STATE, *(session.state for session in SESSIONS.sessions.values())]:
                if state.subscriber_count and state.playback.is_playing:
                    state.tick()
                    await state.notify_change()
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - defensive; keep the ticker alive
            logger.exception("Frame ticker iteration failed")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    ticker = asyncio.create_task(_frame_ticker())
    try:
        yield
    finally:
        ticker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await ticker


app = FastAPI(title="Gridlock - visual demand simulation", lifespan=lifespan)


GRID = load_grid(GEOJSON_PATH)
STATE = State(
    GRID,
    frame_interval_seconds=FRAME_INTERVAL_S,
    sim_step_seconds=SIM_STEP_SECONDS,
    built_mass_path=BUILT_MASS_PATH,
)


SESSIONS = SessionRegistry(lambda: State(
    GRID, frame_interval_seconds=FRAME_INTERVAL_S,
    sim_step_seconds=SIM_STEP_SECONDS, shared=STATE,
))
app.add_middleware(SessionMiddleware, registry=SESSIONS)


def _sse(event_id: int, event: str, data: dict[str, Any]) -> str:
    return f"id: {event_id}\nevent: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def _stream(request: Request):
    """Emit the handshake, then relay the shared frame as it changes.

    A connection is a pure reader: it never advances the clock and never
    composes a frame of its own.
    """
    state = current_state.get() or STATE
    event_id = 0
    state.add_subscriber()
    try:
        yield _sse(event_id, "config", state.grid.config())
        event_id += 1

        yield _sse(event_id, "scenario", state.scenario_payload())
        event_id += 1
        last_scenario = state.scenario_id
        last_scenario_revision = state.scenario_revision

        playback_state = state.playback_state()
        yield _sse(event_id, "playback", playback_state)
        event_id += 1
        last_playback_state = playback_state

        last_version = state.version
        while True:
            if await request.is_disconnected():
                break

            if (
                state.scenario_id != last_scenario
                or state.scenario_revision != last_scenario_revision
            ):
                yield _sse(event_id, "scenario", state.scenario_payload())
                event_id += 1
                last_scenario = state.scenario_id
                last_scenario_revision = state.scenario_revision

            playback_state = state.playback_state()
            if playback_state != last_playback_state:
                yield _sse(event_id, "playback", playback_state)
                event_id += 1
                last_playback_state = playback_state

            yield f"id: {event_id}\nevent: frame\ndata: {state.encoded_frame()}\n\n"
            event_id += 1

            while state.version == last_version:
                await state.wait_for_change(last_version, timeout=FRAME_INTERVAL_S)
                if state.version == last_version:
                    if await request.is_disconnected():
                        return
                    yield ": heartbeat\n\n"
            last_version = state.version
    except asyncio.CancelledError:
        raise
    except Exception:
        # A dead generator closes the response mid-stream with no explanation;
        # log it so the cause is recoverable from the server side.
        logger.exception("Heatmap stream terminated by an unhandled error")
        raise
    finally:
        state.remove_subscriber()


@app.get("/api/heatmap/stream")
async def heatmap_stream(request: Request):
    return StreamingResponse(
        _stream(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "sessions": len(SESSIONS.sessions),
        "subscribers": sum(session.state.subscriber_count for session in SESSIONS.sessions.values()),
        "service_artifact": STATE.service.metadata,
        "composition_seconds": sum(session.state.composition_seconds for session in SESSIONS.sessions.values()),
        "grid": {
            "rows": STATE.grid.rows,
            "cols": STATE.grid.cols,
        },
    }


@app.post("/api/scenario")
async def post_scenario(payload: dict[str, Any]):
    state = current_state.get() or STATE
    scenario_id = payload.get("scenario_id")
    if not isinstance(scenario_id, str):
        raise HTTPException(status_code=400, detail="scenario_id must be a string")
    try:
        state.set_scenario(
            scenario_id,
            stops=payload.get("stops"),
            lines=payload.get("lines"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await state.notify_change()
    return {
        **state.scenario_payload(),
        "frame": state.current_frame(),
    }


@app.get("/api/playback")
async def get_playback():
    state = current_state.get() or STATE
    return state.playback_state()


@app.post("/api/playback")
async def post_playback(payload: dict[str, Any]):
    state = current_state.get() or STATE
    try:
        state.set_playback(
            is_playing=bool(payload["is_playing"]) if "is_playing" in payload else None,
            sim_minutes_per_second=(
                float(payload["sim_minutes_per_second"])
                if "sim_minutes_per_second" in payload
                else None
            ),
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await state.notify_change()
    return state.playback_state()


@app.post("/api/playback/seek")
async def seek_playback(payload: dict[str, Any]):
    state = current_state.get() or STATE
    try:
        if "minute_of_week" in payload:
            state.seek_playback(minute_of_week=int(payload["minute_of_week"]))
        else:
            state.seek_playback(
                day_of_week=int(payload["day_of_week"]),
                time_bin=int(payload["time_bin"]),
            )
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Seek payload must include minute_of_week or day_of_week and time_bin.",
        ) from exc
    await state.notify_change()
    return state.playback_state()


@app.post("/api/people", status_code=201)
async def post_people(payload: dict):
    state = current_state.get() or STATE
    try:
        if len(state.people) >= MAX_PEOPLE:
            raise ValueError(f"at most {MAX_PEOPLE} active crowds are supported")
        entry = parse_person(payload, state.grid.bounds.to_dict())
        person = state.add_person(**entry)
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await state.notify_change()
    return person.to_public_dict(include_tuning=any(
        key in payload for key in ("kind", "duration_minutes", "radius_m", "decay_m")
    ))


@app.post("/api/people/batch", status_code=201)
async def post_people_batch(payload: dict):
    state = current_state.get() or STATE
    try:
        entries = parse_batch(payload, state.grid.bounds.to_dict(), len(state.people))
        people = state.add_people_batch(entries)
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await state.notify_change()
    return {"people": [person.to_public_dict(include_tuning=True) for person in people]}


@app.delete("/api/people/{person_id}")
async def delete_person(person_id: str):
    state = current_state.get() or STATE
    try:
        state.remove_person(person_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="unknown id") from exc
    await state.notify_change()
    return Response(status_code=204)


@app.delete("/api/people")
async def delete_all_people():
    state = current_state.get() or STATE
    state.clear_people()
    await state.notify_change()
    return Response(status_code=204)


@app.get("/api/people")
async def get_people():
    state = current_state.get() or STATE
    return {
        "people": [
            person.to_public_dict()
            for person in state.people.values()
        ],
    }

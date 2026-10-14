from __future__ import annotations

import os
import secrets
import time
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable

from starlette.requests import Request
from starlette.responses import JSONResponse


current_state: ContextVar[Any | None] = ContextVar("simulation_state", default=None)
COOKIE_NAME = "gridlock_session"


@dataclass
class Session:
    state: Any
    touched: float


class SessionRegistry:
    def __init__(self, factory: Callable, ttl: float | None = None, limit: int | None = None):
        self.factory = factory
        self.ttl = float(os.environ.get("SESSION_TTL_SECONDS", "1800")) if ttl is None else ttl
        self.limit = int(os.environ.get("SESSION_LIMIT", "100")) if limit is None else limit
        if self.ttl <= 0 or self.limit <= 0:
            raise ValueError("Session limits must be positive")
        self.sessions: dict[str, Session] = {}

    def cleanup(self):
        now = time.monotonic()
        for key, session in list(self.sessions.items()):
            if session.state.subscriber_count:
                session.touched = now
            elif now - session.touched >= self.ttl:
                del self.sessions[key]

    def resolve(self, key: str | None):
        self.cleanup()
        session = self.sessions.get(key or "")
        if session:
            session.touched = time.monotonic()
        return session

    def create(self):
        self.cleanup()
        if len(self.sessions) >= self.limit:
            return None
        key = secrets.token_urlsafe(32)
        session = Session(self.factory(), time.monotonic())
        self.sessions[key] = session
        return key, session


class SessionMiddleware:
    def __init__(self, app, registry: SessionRegistry):
        self.app = app
        self.registry = registry

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        origin = request.headers.get("origin")
        if request.method not in {"GET", "HEAD", "OPTIONS"} and origin and origin != str(request.base_url).rstrip("/"):
            return await JSONResponse({"detail": "Cross-origin mutation rejected"}, status_code=403)(scope, receive, send)
        previous = request.cookies.get(COOKIE_NAME)
        session = self.registry.resolve(previous)
        if scope["path"] == "/api/session" and request.method == "POST":
            created = session is None
            if created:
                result = self.registry.create()
                if result is None:
                    return await JSONResponse({"detail": "Simulation capacity reached. Please retry shortly."}, status_code=503, headers={"Retry-After": "30"})(scope, receive, send)
                key, session = result
            else:
                key = previous
            response = JSONResponse({"created": created, "reset": created and previous is not None})
            response.set_cookie(COOKIE_NAME, key, httponly=True, samesite="lax", secure=request.url.scheme == "https", path="/api")
            return await response(scope, receive, send)
        if session is None:
            return await JSONResponse({"detail": "Simulation session expired", "code": "session_expired"}, status_code=401)(scope, receive, send)
        token = current_state.set(session.state)
        try:
            await self.app(scope, receive, send)
        finally:
            session.touched = time.monotonic()
            current_state.reset(token)

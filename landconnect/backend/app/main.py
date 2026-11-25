from contextlib import asynccontextmanager
from fastapi import FastAPI, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
import redis.asyncio as aioredis
from sqlalchemy import text

from app.api.v1 import auth, calls, chats, geo, listings, uploads
from app.core.config import get_settings
from app.core.database import AsyncSessionLocal, RequestIdObservabilityMiddleware, configure_logging
from app.services.call_state_machine import CallStateMachineService
from app.websockets.hub import router as ws_router, ws_manager

settings = get_settings()
logger = configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    redis_client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    app.state.redis = redis_client
    app.state.call_service = CallStateMachineService(redis_client, ws_manager.publish_to_user)
    await ws_manager.start(redis_client)
    try:
        yield
    finally:
        app.state.call_service.shutdown()
        await ws_manager.stop()
        await redis_client.aclose()


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestIdObservabilityMiddleware, logger=logger)

app.include_router(auth.router, prefix=settings.API_V1_PREFIX)
app.include_router(geo.router, prefix=settings.API_V1_PREFIX)
app.include_router(listings.router, prefix=settings.API_V1_PREFIX)
app.include_router(chats.router, prefix=settings.API_V1_PREFIX)
app.include_router(calls.router, prefix=settings.API_V1_PREFIX)
app.include_router(uploads.router, prefix=settings.API_V1_PREFIX)
app.include_router(ws_router)


@app.get("/metrics", response_class=PlainTextResponse, tags=["Observability"])
async def prometheus_metrics():
    online_count = await app.state.redis.scard("presence:online") if hasattr(app.state, "redis") else 0
    lines = [
        "# HELP landconnect_ws_online_users Currently connected WebSocket users",
        "# TYPE landconnect_ws_online_users gauge",
        f"landconnect_ws_online_users {int(online_count)}",
    ]
    return "\n".join(lines) + "\n"


@app.get("/health/deep", tags=["Observability"])
async def deep_health_check():
    checks = {"postgres": "down", "postgis": "down", "redis": "down"}
    healthy = True

    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
            checks["postgres"] = "up"
            postgis_ver = await db.scalar(text("SELECT PostGIS_Version()"))
            checks["postgis"] = f"up ({postgis_ver})"
    except Exception as exc:
        healthy = False
        checks["postgres"] = f"error: {exc}"

    try:
        pong = await app.state.redis.ping()
        checks["redis"] = "up" if pong else "down"
    except Exception as exc:
        healthy = False
        checks["redis"] = f"error: {exc}"

    code = status.HTTP_200_OK if healthy else status.HTTP_503_SERVICE_UNAVAILABLE
    return JSONResponse(
        status_code=code,
        content={"status": "healthy" if healthy else "degraded", "checks": checks},
    )

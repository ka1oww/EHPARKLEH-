import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import FastAPI, Query, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Literal
import httpx
import math
import json
import os
import sys
import time
import logging
from pathlib import Path

from restricted import RestrictedDataError, load_restricted_areas

# One definition of the cross-layer dedup radius for the build and the live
# /api/parking/osm layer alike (see backend/restricted.py for the precedent):
# the build folds Google/OSM candidates into a served record within
# DEDUPE_HARD_M on proximity alone, so a live Overpass pin that close to a
# served card is the same physical carpark by the codebase's own rule and is
# suppressed server-side rather than trusting every browser to redo it.
_ENRICH_DIR = Path(__file__).parent / "enrich"
if str(_ENRICH_DIR) not in sys.path:
    sys.path.append(str(_ENRICH_DIR))
from build_enriched import DEDUPE_HARD_M as OSM_DEDUP_M  # noqa: E402

# Load backend/.env for local dev if python-dotenv is installed. In production
# (e.g. Render) config comes from real environment variables and python-dotenv
# may be absent, so this is best-effort and must never crash startup.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
except ModuleNotFoundError:
    pass

# Structured logging instead of silent except/pass + bare print().
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("ehparkleh")

# Per-process correlation values. They contain no host/account data and let
# runtime logs distinguish a normal cache refresh from a real process boot.
PROCESS_BOOT_ID = uuid4().hex[:12]
PROCESS_BOOTED_AT = datetime.now(timezone.utc).isoformat()
PROCESS_BOOT_MONOTONIC = time.monotonic()

# One upstream client is shared for the whole application lifetime so repeated
# cache refreshes reuse connections. Tests may still inject a purpose-built
# client into the cache accessors.
_upstream_client: Optional[httpx.AsyncClient] = None

# Google Places API config (used by the Phase 1 enrichment crawler).
GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")
GOOGLE_PLACES_MAX_CALLS = int(os.getenv("GOOGLE_PLACES_MAX_CALLS", "4000"))

# data.gov.sg live availability feed (keyless).
AVAILABILITY_URL = "https://api.data.gov.sg/v1/transport/carpark-availability"
# How long a fetched availability snapshot is reused before re-fetching.
# The feed refreshes about once a minute, so ~60s avoids hammering it while
# staying fresh enough.
AVAILABILITY_TTL_SECONDS = int(os.getenv("AVAILABILITY_TTL_SECONDS", "60"))

# LTA DataMall EV Charging Points (Batch) for live per-connector availability.
# EVCBatch returns a short-lived link to a JSON of every charger + its status.
# Needs a free DataMall AccountKey; without it, EV *filtering* still works from
# the static flag and only the live "N/M free" count is omitted.
LTA_DATAMALL_KEY = os.getenv("LTA_DATAMALL_KEY", "")
EVC_BATCH_URL = "https://datamall2.mytransport.sg/ltaodataservice/EVCBatch"
EV_AVAILABILITY_TTL_SECONDS = int(os.getenv("EV_AVAILABILITY_TTL_SECONDS", "60"))

# Input bounds. Rejecting coordinates outside Singapore (and capping radius) also
# keeps inf/nan out of the distance math and the Overpass query, and stops an
# oversized radius from turning into an expensive/abusive upstream request.
SG_LAT_MIN, SG_LAT_MAX = 1.13, 1.50
SG_LON_MIN, SG_LON_MAX = 103.55, 104.15
MIN_RADIUS_M, MAX_RADIUS_M = 50, 2000

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load the static carpark dataset once at startup.
    global _carpark_cache, _upstream_client
    global _avail_refresh_task, _ev_refresh_task
    _carpark_cache = load_carpark_records()
    # Load the restricted-area polygons up front so a missing or truncated set
    # aborts the boot instead of silently serving unfiltered results.
    restricted_areas = get_restricted_areas()
    _upstream_client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))
    logger.info(
        "process_boot boot_id=%s booted_at=%s carparks=%d data_file=%s restricted_areas=%d",
        PROCESS_BOOT_ID,
        PROCESS_BOOTED_AT,
        len(_carpark_cache),
        _data_file().name,
        len(restricted_areas),
    )
    try:
        # Seed last-good live snapshots without delaying application readiness.
        # The same single-flight helper is used by /health, so a scheduled
        # health ping repairs an empty/expired cache before the next search.
        prime_live_feed_caches(trigger="startup")
        yield
    finally:
        # A shutdown must not leave refresh tasks using a client that has just
        # been closed. Cancellation does not alter the last-good snapshots.
        refresh_tasks = [
            task
            for task in (_avail_refresh_task, _ev_refresh_task)
            if task is not None and not task.done()
        ]
        for task in refresh_tasks:
            task.cancel()
        if refresh_tasks:
            await asyncio.gather(*refresh_tasks, return_exceptions=True)
        _avail_refresh_task = None
        _ev_refresh_task = None
        await _upstream_client.aclose()
        _upstream_client = None


app = FastAPI(title="EhParkLeh API", version="2", lifespan=lifespan)

# CORS: the production frontend + local dev + native (Capacitor) origins are
# always allowed; add any extra web origin(s) via the ALLOWED_ORIGINS env var
# (comma-separated). No wildcard in production.
_PROD_ORIGINS = [
    "https://ehparkleh.vercel.app",                     # production frontend (Vercel)
]
_BASE_ORIGINS = [
    "http://localhost:5173", "http://localhost:4173",   # vite dev / preview
    "capacitor://localhost", "ionic://localhost",        # iOS Capacitor
    "http://localhost",                                  # Android Capacitor
]
_EXTRA_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
ALLOWED_ORIGINS = _PROD_ORIGINS + _BASE_ORIGINS + _EXTRA_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET"],   # read-only API
    allow_headers=["*"],
    expose_headers=[
        "Server-Timing",
        "Timing-Allow-Origin",
        "X-EhParkLeh-Availability-State",
        "X-EhParkLeh-Availability-Fresh-Until",
        "X-EhParkLeh-Ev-State",
        "X-EhParkLeh-Ev-Fresh-Until",
        "X-EhParkLeh-Generated-At",
        "X-EhParkLeh-Osm-State",
    ],
)

# ---------------------------------------------------------------------------
# Category mapping
# ---------------------------------------------------------------------------
# The enriched dataset stores fine-grained categories; the UI filters by a
# small, stable set. This maps the dataset category -> the public filter value.
CategoryFilter = Literal["HDB", "Mall", "Street", "Private"]

_CATEGORY_MAP = {
    "HDB Estate": "HDB",
    "Mall": "Mall",
    "Street (URA)": "Street",
    "Commercial/Private": "Private",
}


def to_filter_category(dataset_category: Optional[str]) -> Optional[str]:
    """Collapse a dataset category into the public filter category."""
    if dataset_category is None:
        return None
    return _CATEGORY_MAP.get(dataset_category, dataset_category)


# ---------------------------------------------------------------------------
# Pydantic response models
# ---------------------------------------------------------------------------
class Suggestion(BaseModel):
    address: str
    lat: float
    lon: float


class GeocodeResult(BaseModel):
    lat: float
    lon: float
    address: str


class ResolvedRate(BaseModel):
    # The resolved, plain-English-ish price summary for a carpark.
    # Anything we cannot parse stays null / "unknown" rather than a faked value.
    known: bool = False
    summary: str = "unknown"
    first_hour: Optional[float] = None
    subsequent_half_hour: Optional[float] = None
    weekday_raw: Optional[str] = None
    saturday_raw: Optional[str] = None
    sunday_ph_raw: Optional[str] = None


class Carpark(BaseModel):
    id: str
    name: Optional[str] = None
    address: str
    lat: float
    lon: float
    distance_m: int
    lots_available: Optional[int] = None
    total_lots: Optional[int] = None
    type: Optional[str] = None
    category: Optional[str] = None
    rate: ResolvedRate
    free_parking_info: Optional[str] = None
    sources: list[str] = []
    # EV charging (LTA DataMall). ev_available is live (null when the feed is
    # unavailable or no key is configured); the rest is static from the dataset.
    ev: bool = False
    ev_total: Optional[int] = None
    ev_available: Optional[int] = None
    ev_operators: list[str] = []
    ev_max_power_kw: Optional[float] = None
    # Self-service car wash (Beaver / QE) inside the carpark, from Google Places.
    carwash: bool = False
    carwash_operator: Optional[str] = None


class OsmParking(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    distance_m: int
    source: str = "osm"
    fee: Optional[str] = None
    parking_type: Optional[str] = None
    capacity: Optional[str] = None


# Carpark locations are static: loaded once at startup, never re-fetched.
_carpark_cache: list[dict] = []

# Restricted-area polygons (army camps, air/naval bases, prisons) are static too.
# Loaded once and reused; see restricted.py for why this layer, the static
# dataset loader and the build share one definition.
_restricted_areas = None


def get_restricted_areas():
    """Return the shared restricted-area index, loading it on first use.

    Raises RestrictedDataError if the polygons are missing or implausibly small.
    Failing is deliberate: serving with no filter is what put carparks inside
    Kranji Camp in front of users, so an absent polygon set must never degrade
    quietly into "nothing is restricted".
    """
    global _restricted_areas
    if _restricted_areas is None:
        _restricted_areas = load_restricted_areas()
    return _restricted_areas


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------
def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres (accounts for Earth's curvature)."""
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# Degrees-per-metre at Singapore latitudes, used only to draw a generous
# bounding box around a batch of points. Latitude is near-constant; longitude
# shrinks with cos(lat), so the box is sized off the widest cosine in the batch
# and is therefore never narrower than the true circle.
_M_PER_DEG_LAT = 111_195.0
_M_PER_DEG_LON_EQ = 111_320.0


def served_near(points: list[tuple[float, float]], margin_m: float) -> list[dict]:
    """Served records that could sit within margin_m of any of `points`.

    A cheap one-pass bounding-box prefilter over the whole dataset, so the
    per-point proximity test that follows walks a handful of neighbours instead
    of all ~3,500 served records. The box is deliberately loose: it may admit a
    record the exact test then rejects, but it never drops one that is genuinely
    within margin_m.
    """
    if not _carpark_cache or not points:
        return []
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)
    d_lat = margin_m / _M_PER_DEG_LAT
    widest_lat = max(abs(lat_min), abs(lat_max))
    d_lon = margin_m / (_M_PER_DEG_LON_EQ * max(math.cos(math.radians(widest_lat)), 0.01))
    lat_min, lat_max = lat_min - d_lat, lat_max + d_lat
    lon_min, lon_max = lon_min - d_lon, lon_max + d_lon
    return [
        cp
        for cp in _carpark_cache
        if lat_min <= cp["lat"] <= lat_max and lon_min <= cp["lon"] <= lon_max
    ]


def merges_with_served(
    lat: float, lon: float, candidates: Optional[list[dict]] = None
) -> bool:
    """True when a live OSM pin is the same physical carpark as some served card.

    The build already folds crawled OSM/Google candidates into served records
    within OSM_DEDUP_M on proximity alone; without this check the live Overpass
    layer re-pinned those same carparks in the 60-90m band the browser's own net
    lets through. Suppression here is what makes one physical carpark appear at
    most once. With the dataset not yet loaded it suppresses nothing rather than
    everything.

    `candidates` is the served subset a caller has already narrowed down for a
    batch of pins (see served_near); it must contain every served record within
    OSM_DEDUP_M of (lat, lon). Omitted, the whole dataset is scanned.
    """
    records = _carpark_cache if candidates is None else candidates
    if not records:
        return False
    return any(
        haversine(lat, lon, cp["lat"], cp["lon"]) <= OSM_DEDUP_M for cp in records
    )


# ---------------------------------------------------------------------------
# Rates resolution (replaces the lat/lon bounding-box pricing hack)
# ---------------------------------------------------------------------------
def resolve_rate(rates: Optional[dict]) -> ResolvedRate:
    """Turn a parsed LTA-style rates blob into a ResolvedRate.

    Returns an "unknown" rate (known=False) when there is nothing usable,
    so callers never see a fabricated price.
    """
    if not rates or not isinstance(rates, dict):
        return ResolvedRate(known=False, summary="unknown")

    inner = rates.get("rates") if isinstance(rates.get("rates"), dict) else rates

    weekday = inner.get("weekday_1") if isinstance(inner.get("weekday_1"), dict) else {}
    saturday = inner.get("saturday") if isinstance(inner.get("saturday"), dict) else {}
    sunday = (
        inner.get("sunday_publicholiday")
        if isinstance(inner.get("sunday_publicholiday"), dict)
        else {}
    )

    first_hour = weekday.get("first_hour")
    sub_half = weekday.get("subsequent_half_hour")
    weekday_raw = weekday.get("raw")

    summary = "unknown"
    if isinstance(first_hour, (int, float)) and isinstance(sub_half, (int, float)):
        summary = (
            f"${first_hour:.2f} first hour, "
            f"then ${sub_half:.2f} per 1/2 hour (weekday)"
        )
    elif weekday_raw:
        summary = weekday_raw

    known = bool(weekday_raw or first_hour is not None or sub_half is not None)

    return ResolvedRate(
        known=known,
        summary=summary if known else "unknown",
        first_hour=first_hour if isinstance(first_hour, (int, float)) else None,
        subsequent_half_hour=sub_half if isinstance(sub_half, (int, float)) else None,
        weekday_raw=weekday_raw,
        saturday_raw=saturday.get("raw"),
        sunday_ph_raw=sunday.get("raw"),
    )


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def _data_file() -> Path:
    """Prefer the enriched dataset; fall back to the geocoded snapshot."""
    base = Path(__file__).parent
    enriched = base / "carparks_enriched.json"
    if enriched.exists():
        return enriched
    return base / "carparks_geocoded.json"


def load_carpark_records() -> list[dict]:
    """Load and normalise carpark records from disk into the cache shape.

    The restricted filter is applied here, not only in the build. /api/carparks
    used to trust enrich/build_enriched.py to have voided camp/base/prison rows
    already, which held for carparks_enriched.json but not for the
    carparks_geocoded.json fallback _data_file() drops to when that artifact is
    missing: ten of its SVY21-fallback coordinates land inside camp land, and
    each was served with a working navigation deep link. Filtering the records
    as they load makes the rule hold for whichever dataset backs the deploy.

    Raises RestrictedDataError (via get_restricted_areas) rather than loading an
    unfiltered dataset, which is the same fail-closed contract restricted.py and
    /api/parking/osm keep.
    """
    restricted_areas = get_restricted_areas()
    data_file = _data_file()
    with open(data_file) as f:
        records = json.load(f)

    excluded = 0
    out: list[dict] = []
    for cp in records:
        if restricted_areas.contains(cp["lat"], cp["lon"]):
            excluded += 1
            continue
        # Enriched records carry richer fields; geocoded fallback records do
        # not. Use .get() throughout so both shapes load cleanly.
        out.append(
            {
                "id": cp["id"],
                "name": cp.get("name") or cp.get("address"),
                "address": cp.get("address") or cp.get("name") or "Unnamed carpark",
                "lat": cp["lat"],
                "lon": cp["lon"],
                "type": cp.get("type"),
                "category": to_filter_category(cp.get("category")),
                "rates": cp.get("rates"),
                "free_parking_info": cp.get("free_parking", cp.get("free_parking_info")),
                # Key used against the live availability feed.
                "availability_key": cp.get("availability_key", cp["id"]),
                "sources": cp.get("sources", []),
                # EV charging (static layer; ev_cp_ids join the live feed).
                "ev": bool(cp.get("ev")),
                "ev_cp_ids": cp.get("ev_cp_ids", []),
                "ev_total": cp.get("ev_total"),
                "ev_operators": cp.get("ev_operators", []),
                "ev_max_power_kw": cp.get("ev_max_power_kw"),
                "carwash": bool(cp.get("carwash")),
                "carwash_operator": cp.get("carwash_operator"),
            }
        )
    if excluded:
        logger.info(
            "dataset_restricted_excluded data_file=%s excluded=%d kept=%d",
            data_file.name,
            excluded,
            len(out),
        )
    return out


# ---------------------------------------------------------------------------
# Availability fetch with an in-memory TTL cache
# ---------------------------------------------------------------------------
# _avail_cache holds the most recent parsed snapshot and its freshness window.
_avail_cache: dict = {"data": None, "fetched_at": 0.0}
_avail_refresh_task: Optional[asyncio.Task[bool]] = None


@dataclass
class CacheTiming:
    """Request-local cache metadata used for logs and Server-Timing."""

    state: str = "empty"
    refresh: str = "none"
    duration_ms: float = 0.0
    fresh_until: Optional[float] = None


def _live_feed_snapshot(data: dict, ttl_seconds: int) -> dict:
    snapshot_at = time.time()
    return {
        "data": data,
        "fetched_at": time.monotonic(),
        "fresh_until": snapshot_at + ttl_seconds,
    }


def _active_upstream_client(client: Optional[httpx.AsyncClient] = None):
    if client is not None:
        return client
    if _upstream_client is None:
        raise RuntimeError("Upstream client is unavailable outside application lifespan")
    return _upstream_client


def _parse_availability(payload: dict) -> dict:
    """Flatten the data.gov.sg payload into {carpark_number: {...}} for car lots."""
    avail: dict = {}
    for item in payload["items"][0]["carpark_data"]:
        for lot in item["carpark_info"]:
            if lot["lot_type"] == "C":  # car lots only
                avail[item["carpark_number"]] = {
                    "lots_available": int(lot["lots_available"]),
                    "total_lots": int(lot["total_lots"]),
                }
    return avail


async def _refresh_availability(client: Optional[httpx.AsyncClient] = None) -> bool:
    """Fetch and atomically publish a new availability snapshot."""
    global _avail_cache

    started = time.perf_counter()
    retained_snapshot = _avail_cache["data"] is not None
    try:
        upstream = _active_upstream_client(client)
        resp = await upstream.get(AVAILABILITY_URL, timeout=15.0)
        resp.raise_for_status()
        avail = _parse_availability(resp.json())
        # Replace the cache object only after fetch + parse both succeed, so a
        # reader can observe either the complete old snapshot or complete new
        # snapshot, never a partially updated pair of fields.
        _avail_cache = _live_feed_snapshot(avail, AVAILABILITY_TTL_SECONDS)
        logger.info(
            "upstream_refresh phase=availability result=success duration_ms=%.1f "
            "records=%d boot_id=%s",
            (time.perf_counter() - started) * 1000,
            len(avail),
            PROCESS_BOOT_ID,
        )
        return True
    except asyncio.CancelledError:
        logger.info(
            "upstream_refresh phase=availability result=cancelled duration_ms=%.1f boot_id=%s",
            (time.perf_counter() - started) * 1000,
            PROCESS_BOOT_ID,
        )
        raise
    except Exception as exc:
        # Log only the exception class so upstream request details cannot leak
        # into telemetry.
        logger.warning(
            "upstream_refresh phase=availability result=failure duration_ms=%.1f "
            "cache_retained=%s error_type=%s boot_id=%s",
            (time.perf_counter() - started) * 1000,
            retained_snapshot,
            type(exc).__name__,
            PROCESS_BOOT_ID,
        )
        return False


def _clear_availability_refresh(task: asyncio.Task[bool]) -> None:
    global _avail_refresh_task
    if _avail_refresh_task is task:
        _avail_refresh_task = None
    try:
        task.result()
    except asyncio.CancelledError:
        pass
    except Exception:
        # _refresh_availability handles expected failures. Keep this guard so
        # an unexpected programming error is still retrieved and visible.
        logger.exception("Availability refresh task failed unexpectedly")


def _start_availability_refresh(
    client: Optional[httpx.AsyncClient] = None,
) -> tuple[asyncio.Task[bool], str]:
    """Return the one in-flight refresh task, creating it if needed."""
    global _avail_refresh_task
    if _avail_refresh_task is not None and not _avail_refresh_task.done():
        return _avail_refresh_task, "inflight"
    task = asyncio.create_task(
        _refresh_availability(client), name="refresh-carpark-availability"
    )
    _avail_refresh_task = task
    task.add_done_callback(_clear_availability_refresh)
    return task, "scheduled"


async def get_availability(
    client: Optional[httpx.AsyncClient] = None,
    timing: Optional[CacheTiming] = None,
) -> dict:
    """Return availability with stale-while-revalidate and single-flight fetches.

    A cache hit is returned directly. An expired last-good snapshot is returned
    immediately while one background task refreshes it. Only an empty cache
    awaits the shared refresh task, preserving the cold-process behavior.
    """
    phase = timing if timing is not None else CacheTiming()
    started = time.perf_counter()
    try:
        now = time.monotonic()
        cache = _avail_cache
        cached = cache["data"]
        if (
            cached is not None
            and (now - cache["fetched_at"]) < AVAILABILITY_TTL_SECONDS
        ):
            phase.state = "hit"
            phase.fresh_until = cache.get("fresh_until")
            return cached

        task, refresh_state = _start_availability_refresh(client)
        if cached is not None:
            phase.state = "stale"
            phase.refresh = f"background-{refresh_state}"
            phase.fresh_until = cache.get("fresh_until")
            return cached

        phase.state = "empty"
        phase.refresh = f"awaited-{refresh_state}"
        await task
        cache = _avail_cache
        phase.fresh_until = cache.get("fresh_until")
        return cache["data"] or {}
    finally:
        phase.duration_ms = (time.perf_counter() - started) * 1000


# EV charger availability: {evCpId: status}, "0" occupied / "1" available /
# "" | "100" not available. TTL-cached like the carpark feed.
_ev_avail_cache: dict = {"data": None, "fetched_at": 0.0}
_ev_refresh_task: Optional[asyncio.Task[bool]] = None


def _parse_ev_availability(payload: dict) -> dict:
    """Flatten the EVC batch file into {evCpId: status}."""
    status: dict = {}
    for loc in payload.get("evLocationsData") or []:
        for cp in loc.get("chargingPoints") or []:
            for pt in cp.get("plugTypes") or []:
                for ev in pt.get("evIds") or []:
                    cpid = ev.get("evCpId")
                    if cpid:
                        status[cpid] = ev.get("status")
    return status


async def _refresh_ev_availability(client: Optional[httpx.AsyncClient] = None) -> bool:
    """Fetch and atomically publish a new EV connector snapshot."""
    global _ev_avail_cache

    started = time.perf_counter()
    retained_snapshot = _ev_avail_cache["data"] is not None
    try:
        upstream = _active_upstream_client(client)
        meta = await upstream.get(
            EVC_BATCH_URL,
            headers={"AccountKey": LTA_DATAMALL_KEY, "accept": "application/json"},
            timeout=20.0,
        )
        meta.raise_for_status()
        value = meta.json().get("value") or []
        link = value[0]["Link"] if value and value[0].get("Link") else None
        if not link:
            raise RuntimeError("EVCBatch returned no download link")
        # The link is a short-lived (5 min) pre-signed S3 URL; download at once.
        file_resp = await upstream.get(link, timeout=20.0)
        file_resp.raise_for_status()
        status_map = _parse_ev_availability(file_resp.json())
        _ev_avail_cache = _live_feed_snapshot(status_map, EV_AVAILABILITY_TTL_SECONDS)
        logger.info(
            "upstream_refresh phase=ev result=success duration_ms=%.1f connectors=%d boot_id=%s",
            (time.perf_counter() - started) * 1000,
            len(status_map),
            PROCESS_BOOT_ID,
        )
        return True
    except asyncio.CancelledError:
        logger.info(
            "upstream_refresh phase=ev result=cancelled duration_ms=%.1f boot_id=%s",
            (time.perf_counter() - started) * 1000,
            PROCESS_BOOT_ID,
        )
        raise
    except Exception as exc:
        # Do not emit exception text or tracebacks here: failures downloading a
        # signed batch URL can otherwise place that short-lived secret in logs.
        logger.warning(
            "upstream_refresh phase=ev result=failure duration_ms=%.1f "
            "cache_retained=%s error_type=%s boot_id=%s",
            (time.perf_counter() - started) * 1000,
            retained_snapshot,
            type(exc).__name__,
            PROCESS_BOOT_ID,
        )
        return False


def _clear_ev_refresh(task: asyncio.Task[bool]) -> None:
    global _ev_refresh_task
    if _ev_refresh_task is task:
        _ev_refresh_task = None
    try:
        task.result()
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("EV refresh task failed unexpectedly")


def _start_ev_refresh(
    client: Optional[httpx.AsyncClient] = None,
) -> tuple[asyncio.Task[bool], str]:
    """Return the one in-flight EV refresh task, creating it if needed."""
    global _ev_refresh_task
    if _ev_refresh_task is not None and not _ev_refresh_task.done():
        return _ev_refresh_task, "inflight"
    task = asyncio.create_task(_refresh_ev_availability(client), name="refresh-ev-availability")
    _ev_refresh_task = task
    task.add_done_callback(_clear_ev_refresh)
    return task, "scheduled"


async def get_ev_availability(
    client: Optional[httpx.AsyncClient] = None,
    timing: Optional[CacheTiming] = None,
) -> dict:
    """Return EV status with stale-while-revalidate and single-flight fetches."""
    phase = timing if timing is not None else CacheTiming()
    started = time.perf_counter()
    try:
        if not LTA_DATAMALL_KEY:
            phase.state = "disabled"
            return {}

        now = time.monotonic()
        cache = _ev_avail_cache
        cached = cache["data"]
        if (
            cached is not None
            and (now - cache["fetched_at"]) < EV_AVAILABILITY_TTL_SECONDS
        ):
            phase.state = "hit"
            phase.fresh_until = cache.get("fresh_until")
            return cached

        task, refresh_state = _start_ev_refresh(client)
        if cached is not None:
            phase.state = "stale"
            phase.refresh = f"background-{refresh_state}"
            phase.fresh_until = cache.get("fresh_until")
            return cached

        phase.state = "empty"
        phase.refresh = f"awaited-{refresh_state}"
        await task
        cache = _ev_avail_cache
        phase.fresh_until = cache.get("fresh_until")
        return cache["data"] or {}
    finally:
        phase.duration_ms = (time.perf_counter() - started) * 1000


def _cache_state(cache: dict, ttl_seconds: int) -> str:
    """Describe a live-feed snapshot without exposing its contents."""
    if cache["data"] is None:
        return "empty"
    if (time.monotonic() - cache["fetched_at"]) < ttl_seconds:
        return "hit"
    return "stale"


def prime_live_feed_caches(
    *,
    trigger: str,
    client: Optional[httpx.AsyncClient] = None,
) -> dict[str, str]:
    """Refresh empty/expired feed caches in the background, single-flight.

    Startup and the public health check call this helper. It never awaits an
    upstream service, so neither application readiness nor health monitoring is
    turned into another blocking user-facing dependency.
    """
    availability_state = _cache_state(_avail_cache, AVAILABILITY_TTL_SECONDS)
    ev_state = (
        _cache_state(_ev_avail_cache, EV_AVAILABILITY_TTL_SECONDS)
        if LTA_DATAMALL_KEY
        else "disabled"
    )
    refreshes: list[str] = []

    if availability_state != "hit":
        _, refresh_state = _start_availability_refresh(client)
        refreshes.append(f"availability-{refresh_state}")
    if ev_state not in {"hit", "disabled"}:
        _, refresh_state = _start_ev_refresh(client)
        refreshes.append(f"ev-{refresh_state}")

    logger.info(
        "cache_prime trigger=%s availability_state=%s ev_state=%s refreshes=%s boot_id=%s",
        trigger,
        availability_state,
        ev_state,
        ",".join(refreshes) if refreshes else "none",
        PROCESS_BOOT_ID,
    )
    return {"availability": availability_state, "ev": ev_state}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    prime_live_feed_caches(trigger="health")
    return {"status": "ok", "carparks_loaded": len(_carpark_cache)}


@app.get("/api/suggestions", response_model=list[Suggestion])
async def suggestions(q: str = Query(...)):
    if len(q.strip()) < 2:
        return []
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://www.onemap.gov.sg/api/common/elastic/search",
                params={"searchVal": q, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": 1},
            )
        resp.raise_for_status()
        data = resp.json()
    except httpx.TimeoutException as exc:
        logger.exception("OneMap suggestions request timed out")
        raise HTTPException(status_code=504, detail="Address service timed out") from exc
    except Exception as exc:
        logger.exception("OneMap suggestions request failed")
        raise HTTPException(status_code=502, detail="Address service unavailable") from exc
    raw_results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(raw_results, list):
        logger.error("OneMap suggestions returned malformed results: %r", raw_results)
        raise HTTPException(status_code=502, detail="Address service unavailable")

    out: list[Suggestion] = []
    for r in raw_results:
        try:
            out.append(Suggestion(address=r["ADDRESS"], lat=float(r["LATITUDE"]), lon=float(r["LONGITUDE"])))
        except (KeyError, ValueError, TypeError):
            logger.warning("Skipping malformed OneMap suggestion: %r", r)
        if len(out) == 6:
            break
    if raw_results and not out:
        logger.error("OneMap suggestions returned no usable matches")
        raise HTTPException(status_code=502, detail="Address service unavailable")
    return out


@app.get("/api/geocode", response_model=GeocodeResult)
async def geocode(q: str = Query(...)):
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://www.onemap.gov.sg/api/common/elastic/search",
                params={"searchVal": q, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": 1},
            )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        # Upstream unreachable / non-200 / unparseable: a service problem (502),
        # distinct from a valid search that simply found nothing (404 below).
        logger.exception("OneMap geocode request failed")
        raise HTTPException(status_code=502, detail="Geocoding service unavailable")
    raw_results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(raw_results, list):
        logger.error("OneMap geocode returned malformed results: %r", raw_results)
        raise HTTPException(status_code=502, detail="Geocoding service unavailable")

    for r in raw_results:
        try:
            return GeocodeResult(lat=float(r["LATITUDE"]), lon=float(r["LONGITUDE"]), address=r["ADDRESS"])
        except (KeyError, ValueError, TypeError):
            continue
    if raw_results:
        logger.error("OneMap geocode returned no usable matches")
        raise HTTPException(status_code=502, detail="Geocoding service unavailable")
    raise HTTPException(status_code=404, detail="Location not found")


def filter_carparks(
    lat: float,
    lon: float,
    radius: int,
    availability: dict,
    category: Optional[str] = None,
    free_sun_ph: bool = False,
    has_lots: bool = False,
    has_ev: bool = False,
    ev_availability: Optional[dict] = None,
    has_carwash: bool = False,
) -> list[Carpark]:
    """Server-side spatial + category + flag filtering. Pure, so it is testable."""
    ev_availability = ev_availability or {}
    results: list[Carpark] = []
    for cp in _carpark_cache:
        dist = haversine(lat, lon, cp["lat"], cp["lon"])
        if dist > radius:
            continue

        if category and cp.get("category") != category:
            continue

        if has_ev and not cp.get("ev"):
            continue

        if has_carwash and not cp.get("carwash"):
            continue

        avail = availability.get(cp["availability_key"], {})
        lots_available = avail.get("lots_available")
        total_lots = avail.get("total_lots")

        # "Has lots" means counted-and-positive. The live feed only covers
        # HDB/LTA carparks, so a record missing from it is uncounted, not full
        # (every URA street carpark, all malls and Google/OSM-only records):
        # unknown passes, a known 0 is a real full house and goes.
        if has_lots and isinstance(lots_available, int) and lots_available <= 0:
            continue

        # The HDB dataset's only free-parking windows are "SUN & PH FR ...", so
        # a non-"NO" value always means free on Sundays & public holidays.
        free_info = cp.get("free_parking_info")
        is_free = bool(free_info) and str(free_info).upper() != "NO"
        if free_sun_ph and not is_free:
            continue

        # Live EV count: how many of this carpark's connectors report available.
        # Only meaningful when we actually have a feed snapshot; else leave null.
        ev_available = None
        if cp.get("ev") and ev_availability:
            ev_available = sum(
                1 for cid in cp.get("ev_cp_ids", []) if ev_availability.get(cid) == "1"
            )

        try:
            results.append(
                Carpark(
                    id=cp["id"],
                    name=cp.get("name"),
                    address=cp["address"],
                    lat=cp["lat"],
                    lon=cp["lon"],
                    distance_m=round(dist),
                    lots_available=lots_available,
                    total_lots=total_lots,
                    type=cp.get("type"),
                    category=cp.get("category"),
                    rate=resolve_rate(cp.get("rates")),
                    free_parking_info=free_info,
                    sources=cp.get("sources", []),
                    ev=bool(cp.get("ev")),
                    ev_total=cp.get("ev_total"),
                    ev_available=ev_available,
                    ev_operators=cp.get("ev_operators", []),
                    ev_max_power_kw=cp.get("ev_max_power_kw"),
                    carwash=bool(cp.get("carwash")),
                    carwash_operator=cp.get("carwash_operator"),
                )
            )
        except Exception:
            # One malformed record must never 500 the whole search.
            logger.warning("Skipping malformed carpark record %s", cp.get("id"))
            continue

    results.sort(key=lambda c: c.distance_m)
    return results


@app.get("/api/carparks", response_model=list[Carpark])
async def get_carparks(
    response: Response,
    lat: float = Query(..., ge=SG_LAT_MIN, le=SG_LAT_MAX),
    lon: float = Query(..., ge=SG_LON_MIN, le=SG_LON_MAX),
    radius: int = Query(500, ge=MIN_RADIUS_M, le=MAX_RADIUS_M),
    category: Optional[CategoryFilter] = Query(None, description="HDB | Mall | Street | Private"),
    free_sun_ph: bool = Query(False, description="Only carparks free on Sundays & public holidays"),
    has_lots: bool = Query(False, description="Only carparks with live lots available"),
    has_ev: bool = Query(False, description="Only carparks with EV charging"),
    has_carwash: bool = Query(False, description="Only carparks with a self-service car wash"),
):
    request_started = time.perf_counter()
    if not _carpark_cache:
        # Startup loads the cache asynchronously; guard against an empty cache.
        raise HTTPException(
            status_code=503, detail="Carpark data not loaded yet. Try again in a moment."
        )

    availability_timing = CacheTiming()
    ev_timing = CacheTiming()
    # On an empty process both independent feeds may need a blocking first
    # snapshot. Start them together instead of serialising their latency. Once
    # populated, expired snapshots return immediately and refresh in the
    # background through the same calls.
    availability, ev_availability = await asyncio.gather(
        get_availability(timing=availability_timing),
        get_ev_availability(timing=ev_timing),
    )

    filter_started = time.perf_counter()
    results = filter_carparks(
        lat=lat,
        lon=lon,
        radius=radius,
        availability=availability,
        category=category,
        free_sun_ph=free_sun_ph,
        has_lots=has_lots,
        has_ev=has_ev,
        ev_availability=ev_availability,
        has_carwash=has_carwash,
    )
    filter_ms = (time.perf_counter() - filter_started) * 1000
    total_ms = (time.perf_counter() - request_started) * 1000

    # Cache state and phase durations are intentionally visible to the browser
    # so production latency can be attributed without exposing credentials or
    # upstream URLs. Timing-Allow-Origin makes the header readable cross-origin.
    response.headers["Server-Timing"] = ", ".join(
        [
            (
                f'process_uptime;dur={(time.monotonic() - PROCESS_BOOT_MONOTONIC) * 1000:.1f};'
                f'desc="{PROCESS_BOOT_ID}@{PROCESS_BOOTED_AT}"'
            ),
            (
                f'availability;dur={availability_timing.duration_ms:.1f};desc="'
                f'{availability_timing.state}:{availability_timing.refresh}"'
            ),
            (
                f'ev;dur={ev_timing.duration_ms:.1f};desc="'
                f'{ev_timing.state}:{ev_timing.refresh}"'
            ),
            f'local_filter;dur={filter_ms:.1f}',
            f'total;dur={total_ms:.1f}',
        ]
    )
    response.headers["Timing-Allow-Origin"] = "*"
    response.headers["X-EhParkLeh-Availability-State"] = availability_timing.state
    response.headers["X-EhParkLeh-Ev-State"] = ev_timing.state
    if availability_timing.fresh_until is not None:
        response.headers["X-EhParkLeh-Availability-Fresh-Until"] = datetime.fromtimestamp(
            availability_timing.fresh_until, timezone.utc
        ).isoformat()
    if ev_timing.fresh_until is not None:
        response.headers["X-EhParkLeh-Ev-Fresh-Until"] = datetime.fromtimestamp(
            ev_timing.fresh_until, timezone.utc
        ).isoformat()
    response.headers["X-EhParkLeh-Generated-At"] = datetime.now(timezone.utc).isoformat()
    # Live search responses must not be silently replayed by browser or edge
    # caches. The app has an explicit, visibly labelled saved-results fallback.
    response.headers["Cache-Control"] = "no-store"
    logger.info(
        "request_timing endpoint=carparks boot_id=%s "
        "availability_state=%s availability_refresh=%s availability_ms=%.1f "
        "ev_state=%s ev_refresh=%s ev_ms=%.1f local_filter_ms=%.1f "
        "total_ms=%.1f results=%d",
        PROCESS_BOOT_ID,
        availability_timing.state,
        availability_timing.refresh,
        availability_timing.duration_ms,
        ev_timing.state,
        ev_timing.refresh,
        ev_timing.duration_ms,
        filter_ms,
        total_ms,
        len(results),
    )
    return results


# Short TTL cache for the live OSM/Overpass layer, keyed by rounded coords +
# radius (~110m granularity). Overpass enforces strict fair-use and blocks
# abusive IPs; this endpoint is otherwise uncached and hit on every search, so
# caching spares Overpass, lets us serve a stale snapshot on error, and (with the
# radius clamp) blunts hammering / use as a free proxy.
OSM_TTL_SECONDS = int(os.getenv("OSM_TTL_SECONDS", "120"))
OSM_CACHE_MAX = 256
OVERPASS_USER_AGENT = "EhParkLeh/1.0 (+https://ehparkleh.vercel.app)"
_osm_cache: dict = {}  # {(rlat, rlon, radius): (fetched_at, list[OsmParking])}


@app.get("/api/parking/osm", response_model=list[OsmParking])
async def parking_osm(
    response: Response,
    lat: float = Query(..., ge=SG_LAT_MIN, le=SG_LAT_MAX),
    lon: float = Query(..., ge=SG_LON_MIN, le=SG_LON_MAX),
    radius: int = Query(500, ge=MIN_RADIUS_M, le=MAX_RADIUS_M),
):
    key = (round(lat, 3), round(lon, 3), radius)
    cached = _osm_cache.get(key)
    if cached and (time.monotonic() - cached[0]) < OSM_TTL_SECONDS:
        response.headers["X-EhParkLeh-Osm-State"] = "hit"
        return cached[1]

    # OSM records parking that physically exists inside army camps, air/naval
    # bases and prisons. It is real, but no driver can use it, and routing to one
    # sends the driver to a guarded gate, so it is dropped below. This is the
    # same definition the build applies to the static dataset (see
    # restricted.py). Resolved before the Overpass call so a missing polygon set
    # fails here rather than costing an upstream request and then serving
    # everything it returned.
    try:
        restricted_areas = get_restricted_areas()
    except RestrictedDataError as exc:
        logger.exception("restricted-area polygons unavailable")
        raise HTTPException(
            status_code=503, detail="Map parking service unavailable"
        ) from exc

    query = f"""
[out:json][timeout:12];
(
  node["amenity"="parking"](around:{radius},{lat},{lon});
  way["amenity"="parking"](around:{radius},{lat},{lon});
  relation["amenity"="parking"](around:{radius},{lat},{lon});
);
out center;
"""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://overpass-api.de/api/interpreter",
                data={"data": query},
                headers={"User-Agent": OVERPASS_USER_AGENT},
            )
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("remark"):
            raise RuntimeError("Overpass returned an error remark")
        elements = payload["elements"]
        if not isinstance(elements, list):
            raise TypeError("Overpass elements must be a list")
    except Exception as exc:
        logger.exception("Overpass/OSM request failed")
        if cached:
            response.headers["X-EhParkLeh-Osm-State"] = "stale"
            return cached[1]
        status_code = 504 if isinstance(exc, httpx.TimeoutException) else 502
        raise HTTPException(status_code=status_code, detail="Map parking service unavailable") from exc

    located: list[tuple[dict, float, float]] = []
    for el in elements:
        if el["type"] == "node":
            el_lat, el_lon = el["lat"], el["lon"]
        else:
            center = el.get("center")
            if not center:
                continue
            el_lat, el_lon = center["lat"], center["lon"]
        located.append((el, el_lat, el_lon))

    # Narrow the served dataset to this batch's neighbourhood once, instead of
    # re-scanning all served records for every Overpass element. A wide-radius
    # search in dense Singapore returns hundreds of elements, and the full
    # product ran to ~10^6 haversine calls with no await to yield on, blocking
    # the event loop for every other request in flight.
    dedup_candidates = served_near(
        [(el_lat, el_lon) for _, el_lat, el_lon in located], OSM_DEDUP_M
    )

    results: list[OsmParking] = []
    excluded = 0
    deduped = 0
    for el, el_lat, el_lon in located:
        if restricted_areas.contains(el_lat, el_lon):
            excluded += 1
            continue

        if merges_with_served(el_lat, el_lon, dedup_candidates):
            deduped += 1
            continue

        tags = el.get("tags", {})
        name = tags.get("name") or tags.get("addr:street") or "Parking"
        results.append(
            OsmParking(
                id=f"osm_{el['id']}",
                name=name,
                lat=el_lat,
                lon=el_lon,
                distance_m=round(haversine(lat, lon, el_lat, el_lon)),
                fee=tags.get("fee"),
                parking_type=tags.get("parking") or tags.get("car_park_type"),
                capacity=tags.get("capacity"),
            )
        )

    results.sort(key=lambda x: x.distance_m)
    if excluded or deduped:
        logger.info(
            "osm_layer_filtered lat=%s lon=%s radius=%d restricted_excluded=%d "
            "merged_deduped=%d kept=%d",
            lat, lon, radius, excluded, deduped, len(results),
        )

    # Cache the snapshot (evict the oldest entry when full).
    if len(_osm_cache) >= OSM_CACHE_MAX:
        oldest = min(_osm_cache, key=lambda k: _osm_cache[k][0])
        _osm_cache.pop(oldest, None)
    _osm_cache[key] = (time.monotonic(), results)
    response.headers["X-EhParkLeh-Osm-State"] = "fresh"
    return results

from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Literal
import httpx
import math
import json
import os
import time
import logging
from pathlib import Path
from dotenv import load_dotenv

# Load backend/.env at startup so config + secrets live outside the code.
# .env is git-ignored; never commit it.
load_dotenv(Path(__file__).parent / ".env")

# Structured logging instead of silent except/pass + bare print().
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("ehparkleh")

# Google Places API config (used by the Phase 1 enrichment crawler).
GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")
GOOGLE_PLACES_MAX_CALLS = int(os.getenv("GOOGLE_PLACES_MAX_CALLS", "4000"))

# data.gov.sg live availability feed (keyless).
AVAILABILITY_URL = "https://api.data.gov.sg/v1/transport/carpark-availability"
# How long a fetched availability snapshot is reused before re-fetching.
# The feed refreshes about once a minute, so ~60s avoids hammering it while
# staying fresh enough.
AVAILABILITY_TTL_SECONDS = int(os.getenv("AVAILABILITY_TTL_SECONDS", "60"))

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load the static carpark dataset once at startup.
    global _carpark_cache
    _carpark_cache = load_carpark_records()
    logger.info("Loaded %d carparks from %s", len(_carpark_cache), _data_file().name)
    yield


app = FastAPI(title="EhParkLeh API", version="2", lifespan=lifespan)

# CORS: local dev + native (Capacitor) origins are always allowed; add your
# deployed web origin(s) via the ALLOWED_ORIGINS env var (comma-separated).
# No wildcard in production.
_BASE_ORIGINS = [
    "http://localhost:5173", "http://localhost:4173",   # vite dev / preview
    "capacitor://localhost", "ionic://localhost",        # iOS Capacitor
    "http://localhost",                                  # Android Capacitor
]
_EXTRA_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
ALLOWED_ORIGINS = _BASE_ORIGINS + _EXTRA_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET"],   # read-only API
    allow_headers=["*"],
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


# Carpark locations are static — loaded once at startup, never re-fetched.
_carpark_cache: list[dict] = []


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
    """Load and normalise carpark records from disk into the cache shape."""
    data_file = _data_file()
    with open(data_file) as f:
        records = json.load(f)

    out: list[dict] = []
    for cp in records:
        # Enriched records carry richer fields; geocoded fallback records do
        # not. Use .get() throughout so both shapes load cleanly.
        out.append(
            {
                "id": cp["id"],
                "name": cp.get("name") or cp.get("address"),
                "address": cp.get("address", cp.get("name", cp["id"])),
                "lat": cp["lat"],
                "lon": cp["lon"],
                "type": cp.get("type"),
                "category": to_filter_category(cp.get("category")),
                "rates": cp.get("rates"),
                "free_parking_info": cp.get("free_parking", cp.get("free_parking_info")),
                # Key used against the live availability feed.
                "availability_key": cp.get("availability_key", cp["id"]),
                "sources": cp.get("sources", []),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Availability fetch with an in-memory TTL cache
# ---------------------------------------------------------------------------
# _avail_cache holds the most recent parsed snapshot and the time it was taken.
_avail_cache: dict = {"data": None, "fetched_at": 0.0}


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


async def get_availability(client: Optional[httpx.AsyncClient] = None) -> dict:
    """Return the availability map, using a ~60s TTL cache.

    Each search reuses the cached snapshot instead of re-fetching all
    carparks. On a fetch error we log it and serve the last good snapshot
    (or an empty map) rather than failing the whole request.
    """
    now = time.monotonic()
    if (
        _avail_cache["data"] is not None
        and (now - _avail_cache["fetched_at"]) < AVAILABILITY_TTL_SECONDS
    ):
        return _avail_cache["data"]

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=15)
    try:
        resp = await client.get(AVAILABILITY_URL)
        resp.raise_for_status()
        avail = _parse_availability(resp.json())
        _avail_cache["data"] = avail
        _avail_cache["fetched_at"] = now
        logger.info("Refreshed availability: %d carparks", len(avail))
        return avail
    except Exception:
        logger.exception("Failed to fetch/parse availability feed")
        # Serve stale data if we have it, else an empty map.
        return _avail_cache["data"] or {}
    finally:
        if own_client:
            await client.aclose()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
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
    except Exception:
        logger.exception("OneMap suggestions request failed")
        return []
    # Build defensively: skip any result missing the fields we need rather than
    # 500-ing the whole endpoint if OneMap's schema shifts.
    out: list[Suggestion] = []
    for r in data.get("results", [])[:6]:
        try:
            out.append(Suggestion(address=r["ADDRESS"], lat=float(r["LATITUDE"]), lon=float(r["LONGITUDE"])))
        except (KeyError, ValueError, TypeError):
            logger.warning("Skipping malformed OneMap suggestion: %r", r)
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
    # Return the first well-formed result; skip malformed ones; 404 if none.
    for r in (data.get("results") or []):
        try:
            return GeocodeResult(lat=float(r["LATITUDE"]), lon=float(r["LONGITUDE"]), address=r["ADDRESS"])
        except (KeyError, ValueError, TypeError):
            continue
    raise HTTPException(status_code=404, detail="Location not found")


def filter_carparks(
    lat: float,
    lon: float,
    radius: int,
    availability: dict,
    category: Optional[str] = None,
    free_now: bool = False,
    has_lots: bool = False,
) -> list[Carpark]:
    """Server-side spatial + category + flag filtering. Pure, so it is testable."""
    results: list[Carpark] = []
    for cp in _carpark_cache:
        dist = haversine(lat, lon, cp["lat"], cp["lon"])
        if dist > radius:
            continue

        if category and cp.get("category") != category:
            continue

        avail = availability.get(cp["availability_key"], {})
        lots_available = avail.get("lots_available")
        total_lots = avail.get("total_lots")

        if has_lots and not (isinstance(lots_available, int) and lots_available > 0):
            continue

        free_info = cp.get("free_parking_info")
        is_free = bool(free_info) and str(free_info).upper() != "NO"
        if free_now and not is_free:
            continue

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
            )
        )

    results.sort(key=lambda c: c.distance_m)
    return results


@app.get("/api/carparks", response_model=list[Carpark])
async def get_carparks(
    lat: float = Query(...),
    lon: float = Query(...),
    radius: int = Query(500),
    category: Optional[CategoryFilter] = Query(None, description="HDB | Mall | Street | Private"),
    free_now: bool = Query(False, description="Only carparks with free parking now"),
    has_lots: bool = Query(False, description="Only carparks with live lots available"),
):
    if not _carpark_cache:
        # Startup loads the cache asynchronously; guard against an empty cache.
        raise HTTPException(
            status_code=503, detail="Carpark data not loaded yet. Try again in a moment."
        )

    availability = await get_availability()
    return filter_carparks(
        lat=lat,
        lon=lon,
        radius=radius,
        availability=availability,
        category=category,
        free_now=free_now,
        has_lots=has_lots,
    )


@app.get("/api/parking/osm", response_model=list[OsmParking])
async def parking_osm(
    lat: float = Query(...),
    lon: float = Query(...),
    radius: int = Query(500),
):
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
                "https://overpass-api.de/api/interpreter", data={"data": query}
            )
        elements = resp.json().get("elements", [])
    except Exception:
        logger.exception("Overpass/OSM request failed")
        return []

    results: list[OsmParking] = []
    for el in elements:
        if el["type"] == "node":
            el_lat, el_lon = el["lat"], el["lon"]
        else:
            center = el.get("center")
            if not center:
                continue
            el_lat, el_lon = center["lat"], center["lon"]

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
    return results

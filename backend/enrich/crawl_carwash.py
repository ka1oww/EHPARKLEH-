"""Google Places API (New) grid crawler for Singapore car-wash POIs.

Discovers car-wash locations (name + coordinates) so build_enriched.py can flag
the carparks that have a self-service wash machine in them (Beaver, QE Car Care).
Same grid + cap + error handling as crawl_google.py; only the searched type and
output differ. Google is used ONLY to discover the POIs (ToS-safe pattern).

Writes backend/enrich/carwash_points.json as a list of
{place_id, name, lat, lon, primary_type, address}.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parent
ENV_PATH = BACKEND_DIR / ".env"
OUTPUT_PATH = HERE / "carwash_points.json"

load_dotenv(ENV_PATH)

GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "").strip()
GOOGLE_PLACES_MAX_CALLS = int(os.getenv("GOOGLE_PLACES_MAX_CALLS", "4000"))

LAT_MIN, LAT_MAX = 1.20, 1.48
LON_MIN, LON_MAX = 103.60, 104.05

GRID_SPACING_M = 1200.0
SEARCH_RADIUS_M = 900.0
MAX_RESULT_COUNT = 20
THROTTLE_S = 0.35     # ~130 calls/min, under the SearchNearby per-minute quota

PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby"
FIELD_MASK = ("places.displayName,places.location,places.primaryType,places.id,"
              "places.formattedAddress")
M_PER_DEG_LAT = 111_320.0


def log(msg: str) -> None:
    print(f"[crawl_carwash] {msg}", file=sys.stderr, flush=True)


def build_grid() -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    lat_step = GRID_SPACING_M / M_PER_DEG_LAT
    lat = LAT_MIN
    while lat <= LAT_MAX + 1e-9:
        m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat))
        lon_step = GRID_SPACING_M / m_per_deg_lon
        lon = LON_MIN
        while lon <= LON_MAX + 1e-9:
            points.append((round(lat, 6), round(lon, 6)))
            lon += lon_step
        lat += lat_step
    return points


def make_body(lat: float, lon: float) -> dict:
    return {
        "includedTypes": ["car_wash"],
        "maxResultCount": MAX_RESULT_COUNT,
        "locationRestriction": {
            "circle": {"center": {"latitude": lat, "longitude": lon}, "radius": SEARCH_RADIUS_M}
        },
    }


class FatalApiError(Exception):
    pass


class RetryableError(Exception):
    """A transient rate limit; wait and retry rather than abort."""


MAX_RETRIES = 6
RETRY_SLEEP_S = 65.0


def save(pois: dict[str, dict], error: str | None = None) -> None:
    records = list(pois.values())
    # Never clobber a good file with an empty result (e.g. an immediate 429).
    if not records and OUTPUT_PATH.exists():
        try:
            existing = json.loads(OUTPUT_PATH.read_text())
        except Exception:  # noqa: BLE001
            existing = []
        if existing:
            log(f"crawl produced 0 POIs; preserving existing {len(existing)} in {OUTPUT_PATH}")
            return
    OUTPUT_PATH.write_text(json.dumps(records, indent=2, ensure_ascii=False))
    log(f"wrote {len(records)} POIs to {OUTPUT_PATH}")
    if error:
        log(f"NOTE: crawl ended early due to error: {error}")


def crawl() -> None:
    pois: dict[str, dict] = {}
    calls_used = 0
    error_msg: str | None = None

    if not GOOGLE_PLACES_API_KEY:
        error_msg = "GOOGLE_PLACES_API_KEY is empty in backend/.env"
        log(f"ERROR: {error_msg}")
        save(pois, error_msg)
        _report(pois, calls_used, error_msg)
        return

    grid = build_grid()
    log(f"grid: {len(grid)} points (~{GRID_SPACING_M:.0f} m spacing); max calls: {GOOGLE_PLACES_MAX_CALLS}")

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
    }

    try:
        with httpx.Client(timeout=30.0) as client:
            for idx, (lat, lon) in enumerate(grid):
                if calls_used >= GOOGLE_PLACES_MAX_CALLS:
                    error_msg = f"hit GOOGLE_PLACES_MAX_CALLS cap ({GOOGLE_PLACES_MAX_CALLS}); stopping early"
                    log(error_msg)
                    break

                body = make_body(lat, lon)
                if THROTTLE_S:
                    time.sleep(THROTTLE_S)

                places = []
                for attempt in range(MAX_RETRIES + 1):
                    calls_used += 1
                    resp = client.post(PLACES_URL, headers=headers, json=body)
                    if resp.status_code == 200:
                        places = resp.json().get("places", [])
                        break
                    try:
                        _handle_error_response(resp)  # non-fatal -> logs and skips cell
                        break
                    except RetryableError as exc:
                        if attempt >= MAX_RETRIES:
                            raise FatalApiError(f"rate limit did not clear: {exc}")
                        log(f"rate-limited at cell {idx + 1}; sleeping {RETRY_SLEEP_S:.0f}s then retrying")
                        time.sleep(RETRY_SLEEP_S)

                for place in places:
                    pid = place.get("id")
                    if not pid or pid in pois:
                        continue
                    loc = place.get("location", {}) or {}
                    pois[pid] = {
                        "place_id": pid,
                        "name": (place.get("displayName") or {}).get("text", ""),
                        "lat": loc.get("latitude"),
                        "lon": loc.get("longitude"),
                        "primary_type": place.get("primaryType", ""),
                        "address": place.get("formattedAddress", ""),
                    }

                if (idx + 1) % 25 == 0:
                    log(f"progress: {idx + 1}/{len(grid)} cells, {calls_used} calls, {len(pois)} unique POIs")

    except FatalApiError as exc:
        error_msg = str(exc)
        log(f"FATAL: {error_msg}")
    except httpx.HTTPError as exc:
        error_msg = f"network/HTTP error: {exc}"
        log(f"FATAL: {error_msg}")
    except Exception as exc:  # noqa: BLE001
        error_msg = f"unexpected error: {exc!r}"
        log(f"FATAL: {error_msg}")

    save(pois, error_msg)
    _report(pois, calls_used, error_msg)


def _handle_error_response(resp: httpx.Response) -> None:
    try:
        payload = resp.json()
        api_status = (payload.get("error") or {}).get("status", "")
        api_message = (payload.get("error") or {}).get("message", "")
    except Exception:  # noqa: BLE001
        api_status = ""
        api_message = resp.text[:300]
    detail = f"HTTP {resp.status_code} {api_status}: {api_message}".strip()
    msg_lower = (api_status + " " + api_message).lower()
    # Per-minute rate limit is transient -> retry after a pause.
    if resp.status_code == 429 or "resource_exhausted" in msg_lower or "per minute" in msg_lower:
        raise RetryableError(detail)
    # Auth / billing / permission -> hard stop.
    fatal_words = ("billing", "permission", "api key", "denied", "not authorized", "unauthenticated")
    if resp.status_code in (401, 403) or any(w in msg_lower for w in fatal_words):
        raise FatalApiError(detail)
    log(f"WARN: non-fatal response, skipping cell: {detail}")


def _report(pois: dict[str, dict], calls_used: int, error_msg: str | None) -> None:
    print(json.dumps({
        "poi_count": len(pois), "api_calls_used": calls_used,
        "max_calls": GOOGLE_PLACES_MAX_CALLS, "output": str(OUTPUT_PATH), "error": error_msg,
    }, indent=2))


if __name__ == "__main__":
    crawl()

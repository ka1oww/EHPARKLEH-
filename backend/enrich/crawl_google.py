"""Google Places API (New) grid crawler for Singapore parking POIs.

Phase 1 enrichment, "Coverage" layer of the v2 data architecture.

This script discovers parking locations (name + coordinates + place_id) by
running a one-time grid crawl of Singapore with the official Places API (New)
Nearby Search. Google is used ONLY to *discover* that a location exists; the
persistent store and serving stay on the gov + OSM layers (ToS-safe pattern).

Behaviour:
  - Loads GOOGLE_PLACES_API_KEY + GOOGLE_PLACES_MAX_CALLS from backend/.env.
  - Grids Singapore (lat 1.20..1.48, lon 103.60..104.05) at ~1.2 km spacing.
  - For each grid point, POSTs searchNearby (includedTypes ["parking"],
    maxResultCount 20, locationRestriction = circle radius ~900 m).
  - Paginates up to 2 extra pages via nextPageToken (sleeps ~2 s before a
    page-token request, as the token needs a moment to become valid).
  - Dedupes POIs by place id.
  - Stops once GOOGLE_PLACES_MAX_CALLS is reached (hard cap so a bug cannot
    run up a bill) and logs the call count.
  - Writes backend/enrich/google_parking.json as a list of
    {place_id, name, lat, lon, primary_type}.

On any billing / quota / auth error it captures the error, still writes
whatever was collected (even if empty), and reports it.
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

# --- Config -----------------------------------------------------------------

HERE = Path(__file__).resolve().parent          # backend/enrich
BACKEND_DIR = HERE.parent                         # backend
ENV_PATH = BACKEND_DIR / ".env"
OUTPUT_PATH = HERE / "google_parking.json"

load_dotenv(ENV_PATH)

GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "").strip()
GOOGLE_PLACES_MAX_CALLS = int(os.getenv("GOOGLE_PLACES_MAX_CALLS", "4000"))

# Singapore bounding box for the grid crawl.
LAT_MIN, LAT_MAX = 1.20, 1.48
LON_MIN, LON_MAX = 103.60, 104.05

GRID_SPACING_M = 1200.0     # ~1.2 km between grid points
SEARCH_RADIUS_M = 900.0     # circle radius per searchNearby call
MAX_RESULT_COUNT = 20       # max results per call (API max; no pagination)
THROTTLE_S = 0.05           # small inter-call pause to be gentle on the API

# NOTE: Nearby Search (New) does NOT support pagination. Unlike Text Search,
# searchNearby returns at most maxResultCount (<=20) results and there is no
# nextPageToken/pageToken. Including nextPageToken in the field mask (or
# pageToken in the body) yields 400 INVALID_ARGUMENT. The ~900 m radius cells
# overlap on the ~1.2 km grid, so 20 results per cell gives good coverage.
PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby"
FIELD_MASK = "places.displayName,places.location,places.primaryType,places.id"

# Metres per degree latitude is ~constant; longitude shrinks by cos(lat).
M_PER_DEG_LAT = 111_320.0


def log(msg: str) -> None:
    """Print a timestamped log line to stderr so stdout stays clean."""
    print(f"[crawl_google] {msg}", file=sys.stderr, flush=True)


def build_grid() -> list[tuple[float, float]]:
    """Return a list of (lat, lon) grid points covering the SG bbox."""
    points: list[tuple[float, float]] = []
    lat_step = GRID_SPACING_M / M_PER_DEG_LAT

    lat = LAT_MIN
    while lat <= LAT_MAX + 1e-9:
        # Longitude spacing depends on latitude.
        m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(lat))
        lon_step = GRID_SPACING_M / m_per_deg_lon
        lon = LON_MIN
        while lon <= LON_MAX + 1e-9:
            points.append((round(lat, 6), round(lon, 6)))
            lon += lon_step
        lat += lat_step
    return points


def make_body(lat: float, lon: float) -> dict:
    """Build the searchNearby request body for a grid point."""
    return {
        "includedTypes": ["parking"],
        "maxResultCount": MAX_RESULT_COUNT,
        "locationRestriction": {
            "circle": {
                "center": {"latitude": lat, "longitude": lon},
                "radius": SEARCH_RADIUS_M,
            }
        },
    }


class FatalApiError(Exception):
    """Raised on billing / quota / auth errors that should halt the crawl."""


def save(pois: dict[str, dict], error: str | None = None) -> None:
    """Write collected POIs to google_parking.json as a list."""
    records = list(pois.values())
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
    log(
        f"grid: {len(grid)} points (~{GRID_SPACING_M:.0f} m spacing); "
        f"max calls: {GOOGLE_PLACES_MAX_CALLS}"
    )

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
    }

    try:
        with httpx.Client(timeout=30.0) as client:
            for idx, (lat, lon) in enumerate(grid):
                if calls_used >= GOOGLE_PLACES_MAX_CALLS:
                    error_msg = (
                        f"hit GOOGLE_PLACES_MAX_CALLS cap "
                        f"({GOOGLE_PLACES_MAX_CALLS}); stopping early"
                    )
                    log(error_msg)
                    break

                # Nearby Search (New) has no pagination: one call per cell.
                body = make_body(lat, lon)
                calls_used += 1
                if THROTTLE_S:
                    time.sleep(THROTTLE_S)
                resp = client.post(PLACES_URL, headers=headers, json=body)

                if resp.status_code != 200:
                    # Raises FatalApiError on auth/quota/billing; otherwise
                    # logs and skips just this cell.
                    _handle_error_response(resp)
                else:
                    data = resp.json()
                    for place in data.get("places", []):
                        pid = place.get("id")
                        if not pid or pid in pois:
                            continue
                        loc = place.get("location", {}) or {}
                        name = (place.get("displayName") or {}).get("text", "")
                        pois[pid] = {
                            "place_id": pid,
                            "name": name,
                            "lat": loc.get("latitude"),
                            "lon": loc.get("longitude"),
                            "primary_type": place.get("primaryType", ""),
                        }

                if (idx + 1) % 25 == 0:
                    log(
                        f"progress: {idx + 1}/{len(grid)} cells, "
                        f"{calls_used} calls, {len(pois)} unique POIs"
                    )

    except FatalApiError as exc:
        error_msg = str(exc)
        log(f"FATAL: {error_msg}")
    except httpx.HTTPError as exc:
        error_msg = f"network/HTTP error: {exc}"
        log(f"FATAL: {error_msg}")
    except Exception as exc:  # noqa: BLE001 - capture anything, save partial
        error_msg = f"unexpected error: {exc!r}"
        log(f"FATAL: {error_msg}")

    save(pois, error_msg)
    _report(pois, calls_used, error_msg)


def _handle_error_response(resp: httpx.Response) -> None:
    """Inspect a non-200 response; raise FatalApiError on hard failures."""
    try:
        payload = resp.json()
        api_status = (payload.get("error") or {}).get("status", "")
        api_message = (payload.get("error") or {}).get("message", "")
    except Exception:  # noqa: BLE001
        api_status = ""
        api_message = resp.text[:300]

    detail = f"HTTP {resp.status_code} {api_status}: {api_message}".strip()

    # 401/403 = auth, 429 = quota; billing errors surface as 403 PERMISSION_DENIED
    # or in the message. Treat these as fatal so the crawl stops cleanly.
    fatal_codes = {401, 403, 429}
    fatal_words = ("billing", "quota", "permission", "api key", "denied",
                   "not authorized", "exceeded")
    msg_lower = (api_status + " " + api_message).lower()
    if resp.status_code in fatal_codes or any(w in msg_lower for w in fatal_words):
        raise FatalApiError(detail)

    # Otherwise log and let the caller skip just this cell.
    log(f"WARN: non-fatal response, skipping cell: {detail}")


def _report(pois: dict[str, dict], calls_used: int, error_msg: str | None) -> None:
    """Print the machine-readable summary to stdout."""
    summary = {
        "poi_count": len(pois),
        "api_calls_used": calls_used,
        "max_calls": GOOGLE_PLACES_MAX_CALLS,
        "output": str(OUTPUT_PATH),
        "error": error_msg,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    crawl()

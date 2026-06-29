"""Fetch and normalize the three static government parking datasets.

Downloads, from data.gov.sg (keyless), and writes normalized JSON next to this
file:

  1. HDB Carpark Information  -> gov_hdb.json
     (locations, hours, type metadata for every HDB carpark)
  2. URA parking-lot GeoJSON  -> gov_ura.json
     (street parking lots, aggregated by parking-place code into one record per
      parking place with a centroid and lot counts by vehicle type)
  3. LTA Carpark Rates        -> gov_rates.json
     (real weekday / weekend / per-half-hour rates, parsed where possible, to
      replace the hardcoded central/non-central bounding-box pricing)

Run from anywhere:

    python backend/enrich/fetch_gov.py

Outputs go to backend/enrich/. Existing user data files (carparks.json,
carparks_geocoded.json) are never touched. This script only does git-free I/O.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import sys
import time
from pathlib import Path

import httpx

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

OUT_DIR = Path(__file__).parent

DATASETS = {
    "hdb": "d_23f946fa557947f93a8043bbef41dd09",   # HDB Carpark Information (CSV)
    "ura": "d_d959102fa76d58f2de276bfbb7e8f68e",   # URA parking-lot GeoJSON
    "rates": "d_9f6056bdb6b1dfba57f063593e4f34ae",  # LTA Carpark Rates (CSV)
}

POLL_URL = "https://api-open.data.gov.sg/v1/public/api/datasets/{ds}/poll-download"

# data.gov.sg rate-limits the poll endpoint; retry with a fixed backoff.
POLL_RETRIES = 10
POLL_BACKOFF_S = 12


# --------------------------------------------------------------------------- #
# Download helpers
# --------------------------------------------------------------------------- #

def poll_download_url(dataset_id: str) -> str:
    """Resolve a dataset id to a temporary, signed download URL.

    The poll endpoint returns code 0 with a URL on success, or a rate-limit
    code (24 / TOO_MANY_REQUESTS) that we retry through.
    """
    last_err = None
    for attempt in range(1, POLL_RETRIES + 1):
        try:
            resp = httpx.get(POLL_URL.format(ds=dataset_id), timeout=30)
            payload = resp.json()
        except Exception as exc:  # network / JSON error -> retry
            last_err = exc
            print(f"    poll attempt {attempt}/{POLL_RETRIES} errored: {exc}")
            time.sleep(POLL_BACKOFF_S)
            continue

        if payload.get("code") == 0:
            return payload["data"]["url"]

        last_err = payload.get("errorMsg") or payload.get("name")
        print(f"    poll attempt {attempt}/{POLL_RETRIES}: "
              f"{payload.get('name')} (code {payload.get('code')}); "
              f"retrying in {POLL_BACKOFF_S}s")
        time.sleep(POLL_BACKOFF_S)

    raise RuntimeError(f"poll-download failed for {dataset_id}: {last_err}")


def fetch_text(dataset_id: str) -> str:
    """Download a dataset's file as text (CSV or GeoJSON)."""
    url = poll_download_url(dataset_id)
    resp = httpx.get(url, timeout=180, follow_redirects=True)
    resp.raise_for_status()
    return resp.text


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #

def polygon_centroid(coords) -> tuple[float, float]:
    """Return the (lon, lat) centroid of a GeoJSON Polygon ring set.

    Uses a simple average of the outer-ring vertices, which is accurate enough
    for the small lot polygons here (sub-metre relative to map use).
    """
    ring = coords[0]  # outer ring
    pts = [p for p in ring if isinstance(p, (list, tuple)) and len(p) >= 2]
    if not pts:
        return (0.0, 0.0)
    lon = sum(p[0] for p in pts) / len(pts)
    lat = sum(p[1] for p in pts) / len(pts)
    return (lon, lat)


# SVY21 -> WGS84 (kept consistent with backend/main.py for the HDB coords,
# which the dataset supplies in SVY21 easting/northing).
def svy21_to_wgs84(easting: float, northing: float) -> tuple[float, float]:
    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = 2 * f - f * f

    N0, E0, k0 = 38744.572, 28001.642, 1.0
    lat0 = math.radians(1.3674765)
    lon0 = math.radians(103.8255487)

    M0 = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * lat0
              - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * lat0)
              + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * lat0)
              - (35 * e2 ** 3 / 3072) * math.sin(6 * lat0))

    M = M0 + (northing - N0) / k0
    mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))

    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    lat1 = (mu
            + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
            + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))

    N1 = a / math.sqrt(1 - e2 * math.sin(lat1) ** 2)
    T1 = math.tan(lat1) ** 2
    C1 = (e2 / (1 - e2)) * math.cos(lat1) ** 2
    R1 = a * (1 - e2) / (1 - e2 * math.sin(lat1) ** 2) ** 1.5
    D = (easting - E0) / (N1 * k0)

    lat = lat1 - (N1 * math.tan(lat1) / R1) * (
        D ** 2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * e2 / (1 - e2)) * D ** 4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * e2 / (1 - e2) - 3 * C1 ** 2) * D ** 6 / 720
    )
    lon = lon0 + (
        D - (1 + 2 * T1 + C1) * D ** 3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * e2 / (1 - e2) + 24 * T1 ** 2) * D ** 5 / 120
    ) / math.cos(lat1)

    return math.degrees(lat), math.degrees(lon)


# --------------------------------------------------------------------------- #
# Rate parsing (LTA)
# --------------------------------------------------------------------------- #

_MONEY = r"\$?\s*(\d+(?:\.\d+)?)"


def parse_rate_field(raw: str) -> dict | None:
    """Best-effort parse of one LTA rate cell into structured numbers.

    LTA rate cells are free text with many shapes, e.g.:
      "Daily: $1.30 / 30 Mins"
      "$0.018 /min"
      "Mon-Fri: $1.20 for 1st hr; $0.60 for sub. ½ hr or part thereof."
      "$1.12 per hr"
      "Same as Saturday"  /  "-"

    We keep the original string verbatim and add whatever numeric structure we
    can extract, so the backend can show a real price without losing nuance.
    Returns None for blank / placeholder cells.
    """
    if raw is None:
        return None
    text = raw.strip()
    if text in ("", "-", "NA", "N.A.", "N.A"):
        return None

    out: dict = {"raw": text}
    low = text.lower()

    # "Same as ..." cross-references: keep the raw, flag it.
    if low.startswith("same as"):
        out["same_as"] = text
        return out

    # First-hour / subsequent-half-hour tiered structure.
    m_first = re.search(r"" + _MONEY + r"\s*(?:for|/)?\s*(?:1st|first)\s*(?:hr|hour)", low)
    m_sub = re.search(r"" + _MONEY + r"\s*(?:for)?\s*sub", low)
    if m_first:
        out["first_hour"] = float(m_first.group(1))
        if m_sub:
            out["subsequent_half_hour"] = float(m_sub.group(1))
        return out

    # Per-minute rate, e.g. "$0.018 /min".
    m_min = re.search(_MONEY + r"\s*(?:/|per)\s*min", low)
    if m_min:
        per_min = float(m_min.group(1))
        out["per_minute"] = per_min
        out["per_half_hour"] = round(per_min * 30, 4)
        return out

    # Per-30-minutes, e.g. "$1.30 / 30 Mins".
    m_30 = re.search(_MONEY + r"\s*(?:/|per)\s*30\s*min", low)
    if m_30:
        out["per_half_hour"] = float(m_30.group(1))
        return out

    # Per-hour, e.g. "$1.12 per hr".
    m_hr = re.search(_MONEY + r"\s*(?:/|per)\s*(?:hr|hour)", low)
    if m_hr:
        per_hr = float(m_hr.group(1))
        out["per_hour"] = per_hr
        out["per_half_hour"] = round(per_hr / 2, 4)
        return out

    # Couldn't structure it; raw is preserved for display.
    return out


# --------------------------------------------------------------------------- #
# Normalizers
# --------------------------------------------------------------------------- #

def normalize_hdb(csv_text: str) -> list[dict]:
    """One record per HDB carpark with WGS84 coords and metadata."""
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    out = []
    for r in rows:
        rec = {
            "id": (r.get("car_park_no") or "").strip(),
            "source": "hdb",
            "address": (r.get("address") or "").strip(),
            "car_park_type": (r.get("car_park_type") or "").strip(),
            "parking_system": (r.get("type_of_parking_system") or "").strip(),
            "short_term_parking": (r.get("short_term_parking") or "").strip(),
            "free_parking": (r.get("free_parking") or "").strip(),
            "night_parking": (r.get("night_parking") or "").strip(),
            "car_park_decks": (r.get("car_park_decks") or "").strip(),
            "gantry_height": (r.get("gantry_height") or "").strip(),
            "car_park_basement": (r.get("car_park_basement") or "").strip(),
            "lat": None,
            "lon": None,
        }
        # Coordinates are SVY21 easting (x_coord) / northing (y_coord).
        try:
            x = float(r.get("x_coord"))
            y = float(r.get("y_coord"))
            if x and y:
                lat, lon = svy21_to_wgs84(x, y)
                rec["lat"] = round(lat, 7)
                rec["lon"] = round(lon, 7)
        except (TypeError, ValueError):
            pass
        out.append(rec)
    return out


def normalize_ura(geojson_text: str) -> list[dict]:
    """Aggregate URA lot polygons into one record per parking place.

    Each feature is a single lot polygon keyed by PP_CODE (parking-place code)
    with a PARKING_PL name and a vehicle-lot TYPE. We group by PP_CODE, count
    lots per type, and compute a mean centroid of all lot centroids.
    """
    data = json.loads(geojson_text)
    features = data.get("features", [])

    groups: dict[str, dict] = {}
    for f in features:
        props = f.get("properties", {})
        code = props.get("PP_CODE")
        if not code:
            continue
        geom = f.get("geometry") or {}
        if geom.get("type") != "Polygon":
            continue
        lon, lat = polygon_centroid(geom["coordinates"])

        g = groups.setdefault(code, {
            "id": f"ura_{code}",
            "source": "ura",
            "pp_code": code,
            "name": (props.get("PARKING_PL") or "").strip(),
            "lot_counts": {},
            "total_lots": 0,
            "_lon_sum": 0.0,
            "_lat_sum": 0.0,
            "_n": 0,
        })
        vtype = (props.get("TYPE") or "Unknown").strip()
        g["lot_counts"][vtype] = g["lot_counts"].get(vtype, 0) + 1
        g["total_lots"] += 1
        g["_lon_sum"] += lon
        g["_lat_sum"] += lat
        g["_n"] += 1

    out = []
    for g in groups.values():
        n = g.pop("_n") or 1
        lon = g.pop("_lon_sum") / n
        lat = g.pop("_lat_sum") / n
        g["lat"] = round(lat, 7)
        g["lon"] = round(lon, 7)
        g["car_lots"] = g["lot_counts"].get("Car Lots", 0)
        out.append(g)
    out.sort(key=lambda r: r["pp_code"])
    return out


def normalize_rates(csv_text: str) -> list[dict]:
    """One record per LTA-listed carpark with parsed rate structure."""
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    out = []
    for r in rows:
        rec = {
            "carpark": (r.get("carpark") or "").strip(),
            "source": "lta",
            "category": (r.get("category") or "").strip(),
            "rates": {
                "weekday_1": parse_rate_field(r.get("weekdays_rate_1")),
                "weekday_2": parse_rate_field(r.get("weekdays_rate_2")),
                "saturday": parse_rate_field(r.get("saturday_rate")),
                "sunday_publicholiday": parse_rate_field(r.get("sunday_publicholiday_rate")),
            },
        }
        out.append(rec)
    return out


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #

def write_json(name: str, rows: list[dict]) -> Path:
    path = OUT_DIR / f"gov_{name}.json"
    with open(path, "w") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=1)
    return path


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    errors: list[str] = []

    steps = [
        ("hdb", DATASETS["hdb"], normalize_hdb),
        ("ura", DATASETS["ura"], normalize_ura),
        ("rates", DATASETS["rates"], normalize_rates),
    ]

    for name, ds_id, normalizer in steps:
        print(f"[{name}] downloading dataset {ds_id} ...")
        try:
            text = fetch_text(ds_id)
            rows = normalizer(text)
            path = write_json(name, rows)
            counts[name] = len(rows)
            print(f"[{name}] wrote {len(rows)} rows -> {path}")
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            print(f"[{name}] ERROR: {exc}", file=sys.stderr)

    print("\n=== SUMMARY ===")
    for name in ("hdb", "ura", "rates"):
        print(f"gov_{name}.json: {counts.get(name, 'FAILED')}")
    if errors:
        print("ERRORS:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("All datasets fetched and normalized.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

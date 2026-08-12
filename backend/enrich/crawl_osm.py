"""OSM / Overpass crawler for Singapore parking (Phase 1 enrichment).

Queries the Overpass API for every `amenity=parking` feature inside the
Singapore bounding box and writes them to `osm_parking.json` as a flat list of:

    {osm_id, name, lat, lon, access, fee, parking_type}

Nodes use their own lat/lon; ways and relations use the centroid Overpass
returns via `out center`. Overpass is free and keyless but rate-limited and
load-shedding, so requests retry with exponential backoff (it answers 429 /
504 under load, and sometimes drops the connection mid-stream).

Run from anywhere:

    backend/venv/bin/python backend/enrich/crawl_osm.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

# Singapore bounding box (south, west, north, east). Generous enough to cover
# the mainland plus the main offshore islands, tight enough to keep the
# Overpass response sane.
SG_BBOX = (1.130, 103.560, 1.480, 104.130)

# Public Overpass endpoints. We try them in order on each attempt so a single
# overloaded mirror does not abort the whole crawl.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

MAX_RETRIES = 6
BASE_BACKOFF = 5  # seconds; doubles each retry (5, 10, 20, 40, 80, 160)
REQUEST_TIMEOUT = 180  # Overpass can be slow for a country-wide query

# Overpass rejects requests without a descriptive User-Agent (HTTP 406), so
# identify the crawler politely as the API docs request.
HEADERS = {"User-Agent": "EhParkLeh/2.0 (parking finder; enrichment crawler)"}

OUTPUT_FILE = Path(__file__).parent / "osm_parking.json"


def build_query() -> str:
    """Overpass QL: all parking features in the SG bbox, with way/relation centroids."""
    south, west, north, east = SG_BBOX
    bbox = f"{south},{west},{north},{east}"
    return f"""
[out:json][timeout:170];
(
  node["amenity"="parking"]({bbox});
  way["amenity"="parking"]({bbox});
  relation["amenity"="parking"]({bbox});
);
out center tags;
"""


def fetch_overpass(query: str) -> dict:
    """POST the query to Overpass, retrying with exponential backoff.

    Raises RuntimeError if every endpoint fails on every attempt.
    """
    last_error = "unknown error"
    for attempt in range(1, MAX_RETRIES + 1):
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                with httpx.Client(timeout=REQUEST_TIMEOUT, headers=HEADERS) as client:
                    resp = client.post(endpoint, data={"data": query})

                # 429 (too many requests) and 504 (gateway timeout) are the
                # standard Overpass load-shedding codes: back off and retry.
                if resp.status_code in (429, 504):
                    last_error = f"{endpoint} returned HTTP {resp.status_code}"
                    print(f"  [{endpoint}] HTTP {resp.status_code} (rate limited / busy)")
                    continue

                resp.raise_for_status()
                return resp.json()
            except (httpx.HTTPError, json.JSONDecodeError) as exc:
                last_error = f"{endpoint}: {exc!r}"
                print(f"  [{endpoint}] error: {exc!r}")
                continue

        if attempt < MAX_RETRIES:
            wait = BASE_BACKOFF * (2 ** (attempt - 1))
            print(f"Attempt {attempt}/{MAX_RETRIES} failed; backing off {wait}s...")
            time.sleep(wait)

    raise RuntimeError(f"Overpass failed after {MAX_RETRIES} attempts. Last error: {last_error}")


def parse_elements(data: dict) -> list[dict]:
    """Flatten Overpass elements into our record shape."""
    records: list[dict] = []
    skipped_no_coords = 0

    for el in data.get("elements", []):
        el_type = el.get("type")
        if el_type == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            # way / relation: use the centroid from `out center`.
            center = el.get("center")
            if not center:
                skipped_no_coords += 1
                continue
            lat, lon = center.get("lat"), center.get("lon")

        if lat is None or lon is None:
            skipped_no_coords += 1
            continue

        tags = el.get("tags", {})
        name = tags.get("name") or tags.get("operator") or tags.get("addr:street")

        records.append({
            "osm_id": f"{el_type}/{el['id']}",
            "name": name,
            "lat": lat,
            "lon": lon,
            "access": tags.get("access"),
            "fee": tags.get("fee"),
            # OSM uses `parking` for the structure type (surface/multi-storey/
            # underground); fall back to the older `car_park_type` if present.
            "parking_type": tags.get("parking") or tags.get("car_park_type"),
        })

    if skipped_no_coords:
        print(f"Skipped {skipped_no_coords} element(s) with no usable coordinates.")
    return records


def main() -> int:
    print("Querying Overpass for amenity=parking across Singapore...")
    print(f"  bbox (S,W,N,E) = {SG_BBOX}")

    try:
        data = fetch_overpass(build_query())
    except RuntimeError as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        return 1

    records = parse_elements(data)

    with open(OUTPUT_FILE, "w") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)

    named = sum(1 for r in records if r["name"])
    print(f"Wrote {len(records)} parking records to {OUTPUT_FILE}")
    print(f"  {named} have a name; {len(records) - named} are unnamed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

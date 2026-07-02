#!/usr/bin/env python3
"""Fetch Singapore military / camp area polygons from OpenStreetMap (Overpass).

Used by build_enriched.py to VOID any parking that falls inside an army camp,
air base or naval base (none are publicly usable). Output: military_areas.json,
a list of polygon rings, each a list of [lat, lon] points.
"""
import json
import os
import sys
import time
import ssl
import urllib.parse
import urllib.request

# This environment intercepts TLS, breaking default verification. Prefer
# certifi's CA bundle; fall back to unverified for this public, read-only feed.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CTX = ssl.create_default_context()

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "military_areas.json")

BBOX = "1.13,103.56,1.48,104.13"  # Singapore (incl. Tekong)
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# landuse=military covers camp grounds; military=* covers barracks/base/
# training_area/naval_base/airfield/danger_area.
QUERY = f"""
[out:json][timeout:120];
(
  way["landuse"="military"]({BBOX});
  relation["landuse"="military"]({BBOX});
  way["military"]({BBOX});
  relation["military"]({BBOX});
);
out geom;
"""


def fetch():
    last = None
    for attempt in range(6):
        for url in MIRRORS:
            try:
                body = ("data=" + urllib.parse.quote(QUERY)).encode()
                req = urllib.request.Request(
                    url,
                    data=body,
                    headers={
                        "User-Agent": "ehparkleh-military/1.0",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                )
                try:
                    r = urllib.request.urlopen(req, timeout=125, context=SSL_CTX)
                except ssl.SSLError:
                    r = urllib.request.urlopen(req, timeout=125, context=ssl._create_unverified_context())
                with r:
                    return json.load(r)
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  overpass err ({url}): {e}", file=sys.stderr)
        time.sleep(min(5 * 2 ** attempt, 60))
    raise RuntimeError(f"overpass failed after retries: {last}")


def main():
    data = fetch()
    polys = []
    for el in data.get("elements", []):
        t = el.get("type")
        if t == "way" and el.get("geometry"):
            ring = [[p["lat"], p["lon"]] for p in el["geometry"]]
            if len(ring) >= 3:
                polys.append(ring)
        elif t == "relation":
            for m in el.get("members", []):
                # outer rings define the enclosed area; treating inner holes as
                # solid would only void slightly more, which is fine for camps.
                if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("geometry"):
                    ring = [[p["lat"], p["lon"]] for p in m["geometry"]]
                    if len(ring) >= 3:
                        polys.append(ring)
    with open(OUT, "w") as f:
        json.dump(polys, f)
    print(f"military polygons: {len(polys)}")


if __name__ == "__main__":
    main()

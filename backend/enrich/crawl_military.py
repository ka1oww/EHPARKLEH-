#!/usr/bin/env python3
"""Fetch Singapore military / prison area polygons from OpenStreetMap (Overpass).

Feeds the shared restricted-area filter (backend/restricted.py), which both
build_enriched.py and the live /api/parking/osm layer use to drop parking that
sits inside an army camp, air base, naval base or prison (none are publicly
usable). Output: military_areas.json, a list of CLOSED polygon rings, each a
list of [lat, lon] points.
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
# training_area/naval_base/airfield/danger_area; amenity=prison covers the
# prison complexes, which are equally unusable as public parking.
QUERY = f"""
[out:json][timeout:120];
(
  way["landuse"="military"]({BBOX});
  relation["landuse"="military"]({BBOX});
  way["military"]({BBOX});
  relation["military"]({BBOX});
  way["amenity"="prison"]({BBOX});
  relation["amenity"="prison"]({BBOX});
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


def close_ring(ring):
    """Return `ring` with its first point repeated at the end."""
    return ring if ring[0] == ring[-1] else ring + [ring[0]]


def stitch(segments):
    """Assemble OSM multipolygon member ways into closed rings.

    A relation's outer boundary is stored as SEVERAL member ways that share
    endpoints and must be joined end-to-end; each one on its own is an open
    fragment, not a polygon. Treating a fragment as a ring makes point-in-polygon
    test an arbitrary chord of the real area, which both misses the camp and can
    swallow land outside it.

    Returns (closed_rings, leftover_fragments). A leftover means the relation's
    geometry was incomplete upstream, so it is reported rather than shipped.
    """
    pending = [list(s) for s in segments if len(s) >= 2]
    rings, leftovers = [], []
    while pending:
        cur = pending.pop()
        joined = True
        while cur[0] != cur[-1] and joined:
            joined = False
            for i, seg in enumerate(pending):
                if seg[0] == cur[-1]:
                    cur = cur + seg[1:]
                elif seg[-1] == cur[-1]:
                    cur = cur + seg[-2::-1]
                elif seg[-1] == cur[0]:
                    cur = seg[:-1] + cur
                elif seg[0] == cur[0]:
                    cur = seg[:0:-1] + cur
                else:
                    continue
                pending.pop(i)
                joined = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
        else:
            leftovers.append(cur)
    return rings, leftovers


def rings_from_elements(elements):
    """Turn an Overpass `out geom` response into closed [lat, lon] rings."""
    polys, unstitched = [], 0
    for el in elements:
        t = el.get("type")
        if t == "way" and el.get("geometry"):
            ring = [[p["lat"], p["lon"]] for p in el["geometry"]]
            if len(ring) >= 3:
                polys.append(close_ring(ring))
        elif t == "relation":
            # Outer rings define the enclosed area; treating inner holes as
            # solid would only void slightly more, which is fine for camps.
            members = [
                [[p["lat"], p["lon"]] for p in m["geometry"]]
                for m in el.get("members", [])
                if m.get("type") == "way"
                and m.get("role") in ("outer", "")
                and m.get("geometry")
            ]
            rings, leftovers = stitch(members)
            polys += [r for r in rings if len(r) >= 4]
            if leftovers:
                unstitched += len(leftovers)
                name = (el.get("tags") or {}).get("name") or el.get("id")
                print(
                    f"  relation {name}: {len(leftovers)} member run(s) would not close, dropped",
                    file=sys.stderr,
                )
    return polys, unstitched


def main():
    data = fetch()
    polys, unstitched = rings_from_elements(data.get("elements", []))
    open_rings = sum(1 for r in polys if r[0] != r[-1])
    if open_rings:
        raise RuntimeError(f"{open_rings} rings are not closed; refusing to write {OUT}")
    with open(OUT, "w") as f:
        json.dump(polys, f)
    print(f"military/prison polygons: {len(polys)} (unstitched fragments dropped: {unstitched})")


if __name__ == "__main__":
    main()

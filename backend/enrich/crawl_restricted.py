#!/usr/bin/env python3
"""Fetch URA Master Plan SPECIAL USE land parcels (data.gov.sg) so parking that
sits inside a military or security installation can be excluded.

SPECIAL USE is the zoning URA applies to military and security land, and it is
the authoritative, government-maintained answer to "is this a restricted site?".
It is used alongside the crowd-sourced OSM military/prison polygons
(crawl_military.py): URA covers MINDEF/SAF land definitively, OSM adds the Home
Team and police sites URA zones differently. The union is what
backend/restricted.py serves to both the build and the live OSM layer.

Output: restricted_areas.json, a list of closed polygon rings, each [[lat, lon], ...].
Run: backend/venv/bin/python enrich/crawl_restricted.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_gov import fetch_text            # data.gov.sg poll-download + SSL handling
from crawl_central_area import rings_from_geom  # GeoJSON Polygon/MultiPolygon -> [lat, lon] rings

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "restricted_areas.json")
DATASET = "d_90d86daa5bfaa371668b84fa5f01424f"  # MP2019 Land Use layer
LAND_USE = "SPECIAL USE"

# Plausibility floor: the MP2019 layer carries ~61 SPECIAL USE parcels. A much
# smaller answer means the feed changed shape or the filter stopped matching, and
# shipping it would silently disable the restricted-area filter.
MIN_PARCELS = 30


def land_use(props):
    """Read LU_DESC from a feature's properties.

    The layer exposes it as a plain property, but URA's other data.gov.sg
    GeoJSON exports stash attributes in an HTML 'Description' table (see
    crawl_central_area.area_name), so fall back to that shape rather than
    silently matching nothing if this one is ever re-exported that way.
    """
    for key in ("LU_DESC", "lu_desc"):
        v = props.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip().upper()
    blob = props.get("Description") or props.get("description") or ""
    m = re.search(r"LU_DESC\s*</th>\s*<td>\s*([^<]*?)\s*</td>", blob, re.I)
    return m.group(1).strip().upper() if m else None


def close_ring(ring):
    """Return `ring` with its first point repeated at the end."""
    return ring if ring[0] == ring[-1] else ring + [ring[0]]


def main():
    gj = json.loads(fetch_text(DATASET))
    rings, parcels = [], 0
    for f in gj.get("features", []):
        if land_use(f.get("properties", {})) != LAND_USE:
            continue
        parcels += 1
        rings += [close_ring(r) for r in rings_from_geom(f.get("geometry")) if len(r) >= 3]

    if parcels < MIN_PARCELS:
        raise RuntimeError(
            f"only {parcels} '{LAND_USE}' parcels in {len(gj.get('features', []))} features "
            f"(expected >= {MIN_PARCELS}); refusing to write {OUT}"
        )

    with open(OUT, "w") as fh:
        json.dump(rings, fh)
    print(f"URA {LAND_USE} parcels: {parcels} -> rings: {len(rings)} -> {OUT}")


if __name__ == "__main__":
    main()

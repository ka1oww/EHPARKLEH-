#!/usr/bin/env python3
"""Fetch the URA Central Area boundary (Master Plan 2019 planning areas) so HDB/URA
short-term parking rates can be split into Central ($1.20/30min) vs non-Central
($0.60/30min). Output: central_area.json, a list of polygon rings, each [ [lat,lon], ... ].
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_gov import fetch_text  # reuse the data.gov.sg poll-download + SSL handling

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "central_area.json")
DATASET = "d_4765db0e87b9c86336792efe8a1f7a66"  # MP2019 Planning Area Boundary (No Sea)

# The 11 planning areas that make up URA's Central Area.
CENTRAL = {
    "DOWNTOWN CORE", "MARINA EAST", "MARINA SOUTH", "MUSEUM", "NEWTON",
    "ORCHARD", "OUTRAM", "RIVER VALLEY", "ROCHOR", "SINGAPORE RIVER", "STRAITS VIEW",
}


def area_name(props):
    """URA data.gov.sg GeoJSON stashes attributes in an HTML 'Description' table."""
    blob = props.get("Description") or props.get("description") or ""
    m = re.search(r"PLN_AREA_N\s*</th>\s*<td>\s*([^<]+?)\s*</td>", blob, re.I)
    if m:
        return m.group(1).strip().upper()
    for v in props.values():
        if isinstance(v, str) and v.strip().upper() in CENTRAL:
            return v.strip().upper()
    return None


def rings_from_geom(geom):
    out = []
    if not geom:
        return out
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Polygon":
        out.append([[pt[1], pt[0]] for pt in c[0]])
    elif t == "MultiPolygon":
        for poly in c:
            out.append([[pt[1], pt[0]] for pt in poly[0]])
    return out


def main():
    txt = fetch_text(DATASET)
    gj = json.loads(txt)
    rings, hit = [], set()
    for f in gj.get("features", []):
        nm = area_name(f.get("properties", {}))
        if nm in CENTRAL:
            hit.add(nm)
            rings += rings_from_geom(f.get("geometry"))
    with open(OUT, "w") as fh:
        json.dump(rings, fh)
    print(f"matched {len(hit)}/{len(CENTRAL)} central planning areas: {sorted(hit)}")
    print(f"missing: {sorted(CENTRAL - hit)}")
    print(f"rings: {len(rings)} -> {OUT}")


if __name__ == "__main__":
    main()

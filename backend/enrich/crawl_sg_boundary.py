#!/usr/bin/env python3
"""Fetch the full Singapore land boundary (URA MP2019 planning areas, no sea) so
build_enriched.py can void carparks that fall outside Singapore. Google/OSM pull
in many Johor, Malaysia carparks near the Causeway and Second Link; these are not
usable and must not appear.

Output: sg_boundary.json — a list of polygon rings, each [[lat, lon], ...].
Run: backend/venv/bin/python enrich/crawl_sg_boundary.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_gov import fetch_text            # data.gov.sg poll-download + SSL handling
from crawl_central_area import DATASET, rings_from_geom  # same MP2019 dataset

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sg_boundary.json")


def main():
    gj = json.loads(fetch_text(DATASET))
    rings = []
    for f in gj.get("features", []):
        rings += rings_from_geom(f.get("geometry"))
    with open(OUT, "w") as fh:
        json.dump(rings, fh)
    print(f"planning-area rings (all Singapore): {len(rings)} -> {OUT}")


if __name__ == "__main__":
    main()

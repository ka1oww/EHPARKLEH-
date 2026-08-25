"""One definition of "restricted land", shared by the build and the live layer.

Parking inside an army camp, air base, naval base or prison is not publicly
usable, so it must never be offered as a parking option. Two paths into the app
have to honour that: the build-time void in enrich/build_enriched.py, and the
live OpenStreetMap layer served by /api/parking/osm. They previously disagreed:
only the build filtered anything, which is how carparks inside Kranji Camp
reached users. This module is the single definition both now use.

Two polygon sources, unioned because they cover each other's gaps:

  * enrich/restricted_areas.json - URA Master Plan SPECIAL USE parcels
    (crawl_restricted.py). Authoritative and government-maintained; definitive
    for MINDEF/SAF land.
  * enrich/military_areas.json  - OSM landuse=military / military=* / prisons
    (crawl_military.py). Crowd-sourced, but covers Home Team, police and
    defence-research sites URA zones differently.

Fail-closed: loading refuses an empty or implausibly small polygon set rather
than filtering nothing, so a failed crawl or a missing file can never silently
disable the exclusion.
"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ENRICH = os.path.join(HERE, "enrich")

MILITARY_FILE = os.path.join(ENRICH, "military_areas.json")
SPECIAL_USE_FILE = os.path.join(ENRICH, "restricted_areas.json")

# Plausibility floors, set well under the shipped counts (149 OSM military/prison
# rings, 62 URA SPECIAL USE rings) so ordinary upstream churn passes but a
# truncated or empty crawl output does not.
MIN_MILITARY_RINGS = 90
MIN_SPECIAL_USE_RINGS = 40


class RestrictedDataError(RuntimeError):
    """The restricted-area polygons are missing, empty or implausibly small."""


def point_in_ring(plat, plon, ring):
    """Ray-casting point-in-polygon. `ring` is a list of [lat, lon] points."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        ilat, ilon = ring[i]
        jlat, jlon = ring[j]
        if ((ilat > plat) != (jlat > plat)) and (
            plon < (jlon - ilon) * (plat - ilat) / (jlat - ilat) + ilon
        ):
            inside = not inside
        j = i
    return inside


class RestrictedAreas:
    """Bbox-indexed containment test over a set of [lat, lon] rings."""

    def __init__(self, rings):
        self._boxes = []
        for ring in rings:
            lats = [p[0] for p in ring]
            lons = [p[1] for p in ring]
            self._boxes.append((min(lats), max(lats), min(lons), max(lons), ring))

    def __len__(self):
        return len(self._boxes)

    def contains(self, lat, lon):
        """True if (lat, lon) falls inside any restricted polygon."""
        for min_lat, max_lat, min_lon, max_lon, ring in self._boxes:
            if min_lat <= lat <= max_lat and min_lon <= lon <= max_lon:
                if point_in_ring(lat, lon, ring):
                    return True
        return False


def _load_rings(path, minimum):
    try:
        with open(path) as f:
            rings = json.load(f)
    except FileNotFoundError as exc:
        raise RestrictedDataError(
            f"{os.path.basename(path)} is missing; refusing to run without the "
            f"restricted-area filter (regenerate it with enrich/)"
        ) from exc
    if not isinstance(rings, list) or len(rings) < minimum:
        raise RestrictedDataError(
            f"{os.path.basename(path)} has {len(rings) if isinstance(rings, list) else 'no'} "
            f"rings, expected at least {minimum}; refusing to run with a filter that "
            f"would exclude almost nothing"
        )
    return rings


def load_restricted_areas() -> RestrictedAreas:
    """Load the union of URA SPECIAL USE and OSM military/prison polygons.

    Raises RestrictedDataError if either source is missing or implausibly small.
    """
    rings = _load_rings(SPECIAL_USE_FILE, MIN_SPECIAL_USE_RINGS)
    rings = rings + _load_rings(MILITARY_FILE, MIN_MILITARY_RINGS)
    return RestrictedAreas(rings)

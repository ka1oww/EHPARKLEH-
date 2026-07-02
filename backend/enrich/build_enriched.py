#!/usr/bin/env python3
"""Merge + dedupe + classify carpark sources into carparks_enriched.json.

Spine: carparks_geocoded.json (existing ids link to the live availability feed).
Adds Google/OSM-only carparks with new ids, dedupes by spatial proximity + name
similarity, re-geocodes SVY21-fallback entries via OneMap, attaches parsed LTA
rates, and classifies each carpark into a category.
"""
import json
import math
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from difflib import SequenceMatcher

# Build an SSL context. Prefer certifi's CA bundle (the system store is being
# intercepted in this environment, breaking verification); fall back to an
# unverified context for this public, keyless geocoding endpoint only.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CTX = ssl.create_default_context()

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)

GEOCODED = os.path.join(BACKEND, "carparks_geocoded.json")
GOOGLE = os.path.join(HERE, "google_parking.json")
OSM = os.path.join(HERE, "osm_parking.json")
GOV_HDB = os.path.join(HERE, "gov_hdb.json")
GOV_URA = os.path.join(HERE, "gov_ura.json")
GOV_RATES = os.path.join(HERE, "gov_rates.json")
MILITARY = os.path.join(HERE, "military_areas.json")
MANUAL_VOIDS = os.path.join(HERE, "manual_voids.json")
CENTRAL_AREA = os.path.join(HERE, "central_area.json")

OUT = os.path.join(BACKEND, "carparks_enriched.json")
STATS = os.path.join(HERE, "STATS.md")
ONEMAP_CACHE = os.path.join(HERE, "onemap_regeocode_cache.json")

# Source-precedence dedupe. The same physical carpark is often pinned >60m apart
# across sources (gov uses the official centroid, Google the entrance), and their
# names rarely match textually, so a name-gated 60m merge left visible duplicates.
# Policy: gov (spine) is authoritative; Google then OSM fold into it. A candidate
# folds into an existing higher-or-equal-precedence record if it is within
# DEDUPE_HARD_M on PROXIMITY ALONE (catches same registered carpark, mismatched
# names), or within the looser DEDUPE_NAME_M when the names are also similar.
DEDUPE_HARD_M = 90.0   # merge on proximity alone (lower tier folds into higher tier)
DEDUPE_NAME_M = 150.0  # merge further out only when names are similar
NAME_SIM = 0.6         # name similarity threshold
GRID_DEG = 0.0014      # ~155m spatial-hash cells (covers DEDUPE_NAME_M with +/-1 neighbours)


def load(p):
    with open(p) as f:
        return json.load(f)


def load_opt(p, default):
    """Load a JSON file, or return `default` if it is missing.

    The Google / OSM / gov layers may be absent on a fresh deploy (git-ignored
    or not yet crawled); a missing layer degrades coverage but must not break
    the build. The geocoded spine is the only hard requirement.
    """
    try:
        return load(p)
    except FileNotFoundError:
        print(f"  (missing {os.path.basename(p)}, skipping that layer)", file=sys.stderr)
        return default


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


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


def norm_name(s):
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"\b(car\s*park|carpark|basement|multi[- ]?storey|surface|covered)\b", "", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def name_sim(a, b):
    a, b = norm_name(a), norm_name(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


# ---- OneMap re-geocode for SVY21 fallback entries -------------------------

def _open(req):
    try:
        return urllib.request.urlopen(req, timeout=20, context=SSL_CTX)
    except (ssl.SSLError, urllib.error.URLError) as e:
        if isinstance(e, urllib.error.HTTPError):
            raise
        if isinstance(e, urllib.error.URLError) and not isinstance(e.reason, ssl.SSLError):
            raise
        # last resort: intercepted/self-signed chain on a public endpoint
        unverified = ssl._create_unverified_context()
        return urllib.request.urlopen(req, timeout=20, context=unverified)


def onemap_search(q):
    """Query OneMap with retry/backoff on HTTP 429. Raises on persistent failure."""
    url = ("https://www.onemap.gov.sg/api/common/elastic/search?searchVal="
           + urllib.parse.quote(q) + "&returnGeom=Y&getAddrDetails=Y&pageNum=1")
    req = urllib.request.Request(url, headers={"User-Agent": "ehparkleh-v2/1.0"})
    backoff = 2.0
    for attempt in range(6):
        try:
            with _open(req) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            raise
    raise RuntimeError("onemap retries exhausted")


def regeocode_svy21(svy_entries):
    cache = {}
    if os.path.exists(ONEMAP_CACHE):
        cache = load(ONEMAP_CACHE)
    improved = 0
    attempted = 0
    failed = 0
    n = 0
    for cp in svy_entries:
        cid = cp["id"]
        n += 1
        if cid in cache:
            res = cache[cid]
        else:
            attempted += 1
            addr = cp.get("address", "")
            # try a few query variants: building name token, full address
            queries = []
            # building-ish token after BLK numbers
            stripped = re.sub(r"^BLK\s*[\w/]+\s*", "", addr, flags=re.I).strip()
            if stripped:
                queries.append(stripped)
            queries.append(addr)
            res = None
            transient_fail = False
            for q in queries:
                try:
                    d = onemap_search(q)
                except Exception as e:
                    print(f"  onemap err {cid}: {e}", file=sys.stderr)
                    transient_fail = True
                    break
                results = d.get("results") or []
                if results:
                    r0 = results[0]
                    try:
                        res = {"lat": float(r0["LATITUDE"]), "lon": float(r0["LONGITUDE"]),
                               "address": r0.get("ADDRESS"), "matched": r0.get("SEARCHVAL")}
                    except (KeyError, ValueError, TypeError):
                        res = None
                    if res:
                        break
                time.sleep(0.3)
            if transient_fail:
                # do NOT cache transient failures; leave for a future run
                failed += 1
                res = None
            else:
                cache[cid] = res  # cache definitive result (match or confirmed no-match)
            time.sleep(0.4)
            if n % 50 == 0:
                with open(ONEMAP_CACHE, "w") as f:
                    json.dump(cache, f)
                print(f"  progress {n}/{len(svy_entries)} improved={improved} failed={failed}", file=sys.stderr)
        if res:
            d = haversine(cp["lat"], cp["lon"], res["lat"], res["lon"])
            # accept only if it moved (a real different match) but stays in SG bounds
            if 1.15 <= res["lat"] <= 1.48 and 103.6 <= res["lon"] <= 104.1 and d > 1.0:
                cp["lat"] = res["lat"]
                cp["lon"] = res["lon"]
                cp["geocode_source"] = "onemap"
                cp["regeocoded_from"] = "svy21"
                improved += 1
    with open(ONEMAP_CACHE, "w") as f:
        json.dump(cache, f)
    return improved, attempted, failed


# ---- rates matching --------------------------------------------------------

def build_rate_index(rates):
    idx = []
    for r in rates:
        idx.append((norm_name(r["carpark"]), r))
    return idx


def match_rate(name, rate_idx):
    n = norm_name(name)
    if not n:
        return None
    best = None
    best_s = 0.0
    for rn, r in rate_idx:
        if not rn:
            continue
        if n == rn:
            return r
        s = 1.0 if (n in rn or rn in n) and min(len(n), len(rn)) >= 4 else SequenceMatcher(None, n, rn).ratio()
        if s > best_s:
            best_s, best = s, r
    return best if best_s >= 0.82 else None


# ---- classification --------------------------------------------------------

MALL_KW = ["mall", "plaza", "centre", "center", "junction", "city", "point",
           "hub", "square", "shopping", "galleria", "complex", "atrium",
           "the star", "vivocity", "jewel", "jem", "westgate", "tampines 1"]
PRIVATE_KW = ["tower", "building", "office", "hotel", "residenc", "condo",
              "apartment", "club", "hospital", "medical", "industrial", "park "]


def classify(cp):
    sources = cp.get("sources", [])
    # Use both the record name and Google's folded-in facility name, since the
    # canonical name on a merged record is often the gov block address while the
    # mall/facility signal lives in the Google alias.
    names = ((cp.get("name") or cp.get("address") or "")
             + " " + (cp.get("google_name") or "")).lower()
    gtype = (cp.get("google_primary_type") or "").lower()

    if "ura" in sources:
        return "Street (URA)"
    # Registered HDB carparks are authoritative: classify by source BEFORE name,
    # so an HDB block whose address contains "... Centre" is not mislabelled Mall.
    if "hdb" in sources:
        return "HDB Estate"
    if any(k in names for k in MALL_KW):
        return "Mall"
    if any(k in names for k in PRIVATE_KW):
        return "Commercial/Private"
    if gtype in ("parking_garage", "parking_lot"):
        return "Commercial/Private"
    if "lta" in sources:
        return "HDB Estate"
    if "osm" in sources or "google" in sources:
        return "Commercial/Private"
    return "Unclassified"


# ---- main ------------------------------------------------------------------

def main():
    geocoded = load(GEOCODED)  # required: the live-availability spine
    google = load_opt(GOOGLE, [])
    osm = load_opt(OSM, [])
    hdb = {x["id"]: x for x in load_opt(GOV_HDB, [])}
    ura = load_opt(GOV_URA, [])
    rates = load_opt(GOV_RATES, [])

    rate_idx = build_rate_index(rates)

    # 1) spine from geocoded (preserve ids + availability link)
    spine = []
    for cp in geocoded:
        gh = hdb.get(cp["id"])
        # Prefer HDB's official per-carpark coordinates over the address-geocoded
        # ones. OneMap collapsed many distinct carparks on the same street onto a
        # single shared point (stacked map markers); the HDB dataset gives each
        # carpark its true distinct location, and also fixes the SVY21 fallbacks.
        lat, lon, gsrc = cp["lat"], cp["lon"], cp.get("source")
        if gh and isinstance(gh.get("lat"), (int, float)) and isinstance(gh.get("lon"), (int, float)):
            lat, lon, gsrc = gh["lat"], gh["lon"], "hdb_official"
        entry = {
            "id": cp["id"],
            "name": cp.get("address"),
            "address": cp.get("address"),
            "lat": lat,
            "lon": lon,
            "geocode_source": gsrc,
            "availability_key": cp["id"],  # links to live availability feed
            "sources": ["hdb"] if gh else ["lta"],
            "type": cp.get("type"),
            "free_parking": cp.get("free_parking"),
            "rates": None,
            "google_primary_type": None,
        }
        if gh:
            entry["hdb_info"] = {
                "car_park_type": gh.get("car_park_type"),
                "short_term_parking": gh.get("short_term_parking"),
                "night_parking": gh.get("night_parking"),
                "free_parking": gh.get("free_parking"),
                "car_park_decks": gh.get("car_park_decks"),
                "gantry_height": gh.get("gantry_height"),
                "car_park_basement": gh.get("car_park_basement"),
            }
        spine.append(entry)

    # 3) re-geocode SVY21 fallback via OneMap
    svy = [e for e in spine if e["geocode_source"] == "svy21"]
    print(f"re-geocoding {len(svy)} SVY21 entries via OneMap...", file=sys.stderr)
    svy21_improved, svy21_attempted, svy21_failed = regeocode_svy21(svy)
    print(f"  improved {svy21_improved}/{len(svy)} (failed {svy21_failed})", file=sys.stderr)

    # add URA as spine entries (own ids, own availability link)
    for u in ura:
        spine.append({
            "id": u["id"],
            "name": u.get("name"),
            "address": u.get("name"),
            "lat": u["lat"],
            "lon": u["lon"],
            "geocode_source": "ura",
            "availability_key": u.get("pp_code"),
            "sources": ["ura"],
            "type": "STREET/URA",
            "free_parking": None,
            "rates": None,
            "google_primary_type": None,
            "ura_info": {"lot_counts": u.get("lot_counts"), "total_lots": u.get("total_lots")},
        })

    merged = spine

    # spatial grid for dedupe lookups
    def grid_key(lat, lon):
        return (round(lat / GRID_DEG), round(lon / GRID_DEG))

    grid = defaultdict(list)
    for e in merged:
        grid[grid_key(e["lat"], e["lon"])].append(e)

    def find_dup(lat, lon, name):
        """Find the existing carpark this candidate duplicates, or None.

        The gov spine is added first, then Google, then OSM, so any match is an
        authoritative-or-earlier source the candidate should fold INTO (its coords
        and id win). Merge on proximity alone within DEDUPE_HARD_M (handles the same
        registered carpark pinned at slightly different coords with mismatched
        names); extend to DEDUPE_NAME_M only when the names are also similar.
        """
        gk = grid_key(lat, lon)
        best = None
        best_d = DEDUPE_NAME_M
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for e in grid.get((gk[0] + dx, gk[1] + dy), []):
                    d = haversine(lat, lon, e["lat"], e["lon"])
                    if d > DEDUPE_NAME_M:
                        continue
                    s = name_sim(name, e.get("name") or e.get("address"))
                    same = d <= DEDUPE_HARD_M or (s >= NAME_SIM and d <= DEDUPE_NAME_M)
                    if same and d < best_d:
                        best_d, best = d, e
        return best

    merges = 0
    new_google = 0
    new_osm = 0
    gid = 0
    oid = 0

    # 2) merge Google-discovered carparks
    for g in google:
        lat = g.get("location", {}).get("latitude") if isinstance(g.get("location"), dict) else g.get("lat")
        lon = g.get("location", {}).get("longitude") if isinstance(g.get("location"), dict) else g.get("lon")
        if lat is None or lon is None:
            continue
        nm = g.get("displayName", {}).get("text") if isinstance(g.get("displayName"), dict) else g.get("name")
        ptype = g.get("primaryType") or g.get("primary_type")
        dup = find_dup(lat, lon, nm)
        if dup:
            if "google" not in dup["sources"]:
                dup["sources"].append("google")
            if ptype and not dup.get("google_primary_type"):
                dup["google_primary_type"] = ptype
            if g.get("id"):
                dup["google_place_id"] = g["id"]
            if nm and not dup.get("google_name"):
                dup["google_name"] = nm  # keep Google's facility name as an alias
            merges += 1
        else:
            gid += 1
            e = {
                "id": f"GOOG_{gid:05d}",
                "name": nm, "address": nm, "lat": lat, "lon": lon,
                "geocode_source": "google", "availability_key": None,
                "sources": ["google"], "type": None, "free_parking": None,
                "rates": None, "google_primary_type": ptype,
                "google_place_id": g.get("id"),
            }
            merged.append(e)
            grid[grid_key(lat, lon)].append(e)
            new_google += 1

    # merge OSM
    for o in osm:
        lat, lon = o.get("lat"), o.get("lon")
        if lat is None or lon is None:
            continue
        nm = o.get("name")
        dup = find_dup(lat, lon, nm)
        if dup:
            if "osm" not in dup["sources"]:
                dup["sources"].append("osm")
            dup.setdefault("osm_info", {"osm_id": o.get("osm_id"), "access": o.get("access"),
                                        "fee": o.get("fee"), "parking_type": o.get("parking_type")})
            merges += 1
        else:
            oid += 1
            e = {
                "id": f"OSM_{oid:05d}",
                "name": nm, "address": nm, "lat": lat, "lon": lon,
                "geocode_source": "osm", "availability_key": None,
                "sources": ["osm"], "type": (o.get("parking_type") or "").upper() or None,
                "free_parking": None, "rates": None, "google_primary_type": None,
                "osm_info": {"osm_id": o.get("osm_id"), "access": o.get("access"),
                             "fee": o.get("fee"), "parking_type": o.get("parking_type")},
            }
            merged.append(e)
            grid[grid_key(lat, lon)].append(e)
            new_osm += 1

    # 3b) void parking inside military areas (camps / air / naval bases): not
    # publicly usable, so it must not appear as a parking option.
    mil = load_opt(MILITARY, [])
    mil_areas = []
    for ring in mil:
        lats = [p[0] for p in ring]
        lons = [p[1] for p in ring]
        mil_areas.append((min(lats), max(lats), min(lons), max(lons), ring))

    def in_military(lat, lon):
        for mnlat, mxlat, mnlon, mxlon, ring in mil_areas:
            if mnlat <= lat <= mxlat and mnlon <= lon <= mxlon and point_in_ring(lat, lon, ring):
                return True
        return False

    before_void = len(merged)
    merged = [e for e in merged if not in_military(e["lat"], e["lon"])]
    voided_military = before_void - len(merged)
    print(f"voided {voided_military} carparks inside {len(mil_areas)} military areas", file=sys.stderr)

    # 3c) drop the OSM coverage layer + apply the manual removal list.
    # OSM-only pins were the main source of construction-site / private / unnamed
    # junk, so we stop emitting them (OSM is still used above to corroborate/fold
    # during dedup). Then remove the satellite-verified Google junk, Google
    # condos, and the user-flagged entry listed in manual_voids.json.
    before_osm = len(merged)
    merged = [e for e in merged if not e["id"].startswith("OSM_")]
    dropped_osm = before_osm - len(merged)
    print(f"dropped {dropped_osm} standalone OSM carparks", file=sys.stderr)

    voids = set(load_opt(MANUAL_VOIDS, []))
    missing = voids - {e["id"] for e in merged}
    if missing:
        print(f"  WARNING: {len(missing)} manual_void ids matched nothing: {sorted(missing)}",
              file=sys.stderr)
    before_manual = len(merged)
    merged = [e for e in merged if e["id"] not in voids]
    voided_manual = before_manual - len(merged)
    print(f"voided {voided_manual} carparks from manual_voids.json", file=sys.stderr)

    # Central Area geofence (URA planning areas) for the HDB/URA standard rate:
    # $1.20/30min inside the Central Area, $0.60/30min elsewhere.
    central_boxes = []
    for ring in load_opt(CENTRAL_AREA, []):
        lats = [p[0] for p in ring]
        lons = [p[1] for p in ring]
        central_boxes.append((min(lats), max(lats), min(lons), max(lons), ring))

    def in_central(lat, lon):
        for mnlat, mxlat, mnlon, mxlon, ring in central_boxes:
            if mnlat <= lat <= mxlat and mnlon <= lon <= mxlon and point_in_ring(lat, lon, ring):
                return True
        return False

    def standard_rate(central):
        per, cap = (1.20, 20) if central else (0.60, 12)
        zone = "Central Area" if central else "non-Central"
        return {
            "category": f"HDB/URA standard ({zone})",
            "rates": {"weekday_1": {
                "raw": f"${per:.2f} / 30 min (max ${cap}/day)",
                "subsequent_half_hour": per,
                "per_half_hour": per,
            }},
        }

    # 4) attach rates + 5) classify
    rates_attached = 0
    standard_attached = 0
    for e in merged:
        r = match_rate(e.get("name") or e.get("address"), rate_idx)
        if r:
            e["rates"] = {"category": r.get("category"), "rates": r.get("rates")}
            if "lta" not in e["sources"]:
                e["sources"].append("lta")
            rates_attached += 1
        else:
            # No exact dataset rate: apply the published HDB/URA standard schedule
            # to gov carparks that actually offer short-term parking.
            src = set(e.get("sources", []))
            st = (e.get("hdb_info") or {}).get("short_term_parking")
            offers = ("hdb" in src and (not st or str(st).upper() != "NO")) or ("ura" in src)
            if offers:
                e["rates"] = standard_rate(in_central(e["lat"], e["lon"]))
                standard_attached += 1
        e["category"] = classify(e)

    with open(OUT, "w") as f:
        json.dump(merged, f, indent=1)

    # 6) stats
    cat_counts = Counter(e["category"] for e in merged)
    src_counts = Counter()
    for e in merged:
        for s in e["sources"]:
            src_counts[s] += 1
    final_svy = sum(1 for e in merged if e.get("geocode_source") == "svy21")

    lines = []
    lines.append("# Enriched Carpark Dataset — Stats\n")
    lines.append(f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    lines.append(f"**Total carparks:** {len(merged)}\n")
    lines.append("## By category\n")
    for c, n in cat_counts.most_common():
        lines.append(f"- {c}: {n}")
    lines.append("\n## By source (carparks tagged with each source)\n")
    for s, n in src_counts.most_common():
        lines.append(f"- {s}: {n}")
    lines.append("\n## Pipeline\n")
    lines.append(f"- Spine (existing geocoded ids preserved): {len(geocoded)}")
    lines.append(f"- URA street parking added: {len(ura)}")
    lines.append(f"- Google-discovered carparks (input): {len(google)} -> new ids added: {new_google}")
    lines.append(f"- OSM carparks (input): {len(osm)} -> new ids added: {new_osm}")
    lines.append(f"- Dedupe merges (Google/OSM folded into existing): {merges}")
    lines.append(f"- Dedupe policy: gov authoritative; fold within {DEDUPE_HARD_M:.0f}m proximity, or {DEDUPE_NAME_M:.0f}m when names match")
    lines.append(f"- Voided inside military areas ({len(mil_areas)} camps/bases): {voided_military}")
    lines.append(f"- Dropped standalone OSM carparks: {dropped_osm}")
    lines.append(f"- Voided from manual_voids.json (Google junk/condos + flagged): {voided_manual}")
    lines.append(f"- LTA rates attached: {rates_attached} (of {len(rates)} rate rows)")
    lines.append(f"- HDB/URA standard rates applied: {standard_attached}")
    lines.append(f"\n## Geocoding\n")
    lines.append(f"- SVY21 fallback before: 467")
    lines.append(f"- OneMap re-geocode attempts: {svy21_attempted} (rest cached)")
    lines.append(f"- OneMap transient failures (not cached, retry next run): {svy21_failed}")
    lines.append(f"- SVY21 entries improved via OneMap: {svy21_improved}")
    lines.append(f"- SVY21 fallback remaining: {final_svy}")
    with open(STATS, "w") as f:
        f.write("\n".join(lines) + "\n")

    print("\n".join(lines))


if __name__ == "__main__":
    main()

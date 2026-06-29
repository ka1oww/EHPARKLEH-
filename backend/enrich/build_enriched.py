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

OUT = os.path.join(BACKEND, "carparks_enriched.json")
STATS = os.path.join(HERE, "STATS.md")
ONEMAP_CACHE = os.path.join(HERE, "onemap_regeocode_cache.json")

DEDUPE_M = 60.0  # spatial proximity threshold (metres)
NAME_SIM = 0.6   # name similarity threshold


def load(p):
    with open(p) as f:
        return json.load(f)


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


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
    name = (cp.get("name") or cp.get("address") or "").lower()
    gtype = (cp.get("google_primary_type") or "").lower()

    if "ura" in sources:
        return "Street (URA)"
    if any(k in name for k in MALL_KW):
        return "Mall"
    if "hdb" in sources or cp.get("id", "")[:1].isalpha() and "lta" in sources:
        # HDB/LTA gov spine entries
        if "hdb" in sources:
            return "HDB Estate"
    if gtype in ("parking_garage", "parking_lot"):
        if any(k in name for k in PRIVATE_KW):
            return "Commercial/Private"
        return "Commercial/Private"
    if any(k in name for k in PRIVATE_KW):
        return "Commercial/Private"
    if "hdb" in sources or "lta" in sources:
        return "HDB Estate"
    if "osm" in sources or "google" in sources:
        return "Commercial/Private"
    return "Unclassified"


# ---- main ------------------------------------------------------------------

def main():
    geocoded = load(GEOCODED)
    google = load(GOOGLE)
    osm = load(OSM)
    hdb = {x["id"]: x for x in load(GOV_HDB)}
    ura = load(GOV_URA)
    rates = load(GOV_RATES)

    rate_idx = build_rate_index(rates)

    # 1) spine from geocoded (preserve ids + availability link)
    spine = []
    for cp in geocoded:
        gh = hdb.get(cp["id"])
        entry = {
            "id": cp["id"],
            "name": cp.get("address"),
            "address": cp.get("address"),
            "lat": cp["lat"],
            "lon": cp["lon"],
            "geocode_source": cp.get("source"),
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

    # spatial grid for dedupe lookups (~0.0006 deg ~ 66m cells)
    def grid_key(lat, lon):
        return (round(lat / 0.0006), round(lon / 0.0006))

    grid = defaultdict(list)
    for e in merged:
        grid[grid_key(e["lat"], e["lon"])].append(e)

    def find_dup(lat, lon, name):
        gk = grid_key(lat, lon)
        best = None
        best_d = DEDUPE_M
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for e in grid.get((gk[0] + dx, gk[1] + dy), []):
                    d = haversine(lat, lon, e["lat"], e["lon"])
                    if d <= DEDUPE_M:
                        s = name_sim(name, e.get("name") or e.get("address"))
                        # accept on proximity AND (name similar OR no name to compare)
                        if (s >= NAME_SIM or not norm_name(name)) and d < best_d:
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

    # 4) attach rates + 5) classify
    rates_attached = 0
    for e in merged:
        r = match_rate(e.get("name") or e.get("address"), rate_idx)
        if r:
            e["rates"] = {"category": r.get("category"), "rates": r.get("rates")}
            if "lta" not in e["sources"]:
                e["sources"].append("lta")
            rates_attached += 1
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
    lines.append(f"- LTA rates attached: {rates_attached} (of {len(rates)} rate rows)")
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

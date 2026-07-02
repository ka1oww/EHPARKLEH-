#!/usr/bin/env python3
"""Fetch all EV charging points in Singapore from LTA DataMall's EV Charging
Points (Batch) API and save them to ev_points.json for the enrichment build.

The Batch endpoint (EVCBatch) returns a short-lived (5 min) pre-signed S3 link
to a single JSON file of every charging location and its connectors. We flatten
each location to {name, address, lat, lon, postalCode, connectors:[...]}, where
each connector carries its LTA-assigned evCpId — the stable id main.py uses to
join live per-connector availability at request time.

Needs LTA_DATAMALL_KEY (a free DataMall AccountKey) in backend/.env or the
environment. Run: backend/venv/bin/python enrich/crawl_ev.py
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
OUT = os.path.join(HERE, "ev_points.json")

EVC_BATCH_URL = "https://datamall2.mytransport.sg/ltaodataservice/EVCBatch"


def account_key():
    """DataMall AccountKey from the environment, or backend/.env for local runs."""
    key = os.getenv("LTA_DATAMALL_KEY")
    if key:
        return key
    env = os.path.join(BACKEND, ".env")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("LTA_DATAMALL_KEY="):
                return line.split("=", 1)[1].strip()
    return None


def _ctx():
    # This machine's system CA store is intercepted; prefer certifi's bundle and
    # fall back to an unverified context for these public read-only endpoints.
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        return urllib.request.urlopen(req, timeout=60, context=_ctx()).read()
    except urllib.error.HTTPError:
        raise
    except (ssl.SSLError, urllib.error.URLError):
        return urllib.request.urlopen(
            req, timeout=60, context=ssl._create_unverified_context()
        ).read()


def fetch_batch(key):
    meta = json.loads(_get(EVC_BATCH_URL, {"AccountKey": key, "accept": "application/json"}))
    value = meta.get("value") or meta.get("Value") or []
    if not value or not value[0].get("Link"):
        raise RuntimeError("EVCBatch returned no download link")
    payload = json.loads(_get(value[0]["Link"]))
    return payload.get("evLocationsData") or [], payload.get("LastUpdatedTime")


def flatten(locations):
    out = []
    for loc in locations:
        lat, lon = loc.get("latitude"), loc.get("longtitude")  # note LTA's spelling
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        connectors = []
        for cp in loc.get("chargingPoints") or []:
            operator = cp.get("operator")
            for pt in cp.get("plugTypes") or []:
                for ev in pt.get("evIds") or []:
                    cpid = ev.get("evCpId")
                    if not cpid:
                        continue
                    connectors.append({
                        "evCpId": cpid,
                        "operator": operator,
                        "plugType": pt.get("plugType"),
                        "powerRating": pt.get("powerRating"),
                        "current": pt.get("current"),
                        "priceType": pt.get("priceType"),
                        "price": pt.get("price"),
                    })
        if not connectors:
            continue
        out.append({
            "name": loc.get("name"),
            "address": loc.get("address"),
            "lat": float(lat),
            "lon": float(lon),
            "postalCode": loc.get("postalCode"),
            "connectors": connectors,
        })
    return out


def main():
    key = account_key()
    if not key:
        print("ERROR: LTA_DATAMALL_KEY not set (backend/.env or environment)", file=sys.stderr)
        sys.exit(1)
    locations, updated = fetch_batch(key)
    points = flatten(locations)
    with open(OUT, "w") as f:
        json.dump(points, f)
    total_connectors = sum(len(p["connectors"]) for p in points)
    print(f"EV locations: {len(points)} | connectors: {total_connectors} | LastUpdated: {updated}")
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()

"""
One-time script: geocode all carpark addresses via OneMap and save
pre-computed lat/lon to carparks_geocoded.json.

Run: python3 geocode_carparks.py
"""
import json, math, time, httpx, asyncio
from pathlib import Path

def svy21_to_wgs84(easting, northing):
    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = 2 * f - f * f
    N0, E0, k0 = 38744.572, 28001.642, 1.0
    lat0 = math.radians(1.3674765)
    lon0 = math.radians(103.8255487)
    M0 = a * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * lat0
              - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * math.sin(2*lat0)
              + (15*e2**2/256 + 45*e2**3/1024) * math.sin(4*lat0)
              - (35*e2**3/3072) * math.sin(6*lat0))
    M = M0 + (northing - N0) / k0
    mu = M / (a * (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    lat1 = (mu + (3*e1/2 - 27*e1**3/32) * math.sin(2*mu)
            + (21*e1**2/16 - 55*e1**4/32) * math.sin(4*mu)
            + (151*e1**3/96) * math.sin(6*mu)
            + (1097*e1**4/512) * math.sin(8*mu))
    N1 = a / math.sqrt(1 - e2 * math.sin(lat1)**2)
    T1 = math.tan(lat1)**2
    C1 = (e2 / (1 - e2)) * math.cos(lat1)**2
    R1 = a * (1 - e2) / (1 - e2 * math.sin(lat1)**2)**1.5
    D = (easting - E0) / (N1 * k0)
    lat = lat1 - (N1 * math.tan(lat1) / R1) * (
        D**2/2 - (5 + 3*T1 + 10*C1 - 4*C1**2 - 9*e2/(1-e2)) * D**4/24
        + (61 + 90*T1 + 298*C1 + 45*T1**2 - 252*e2/(1-e2) - 3*C1**2) * D**6/720)
    lon = lon0 + (D - (1 + 2*T1 + C1) * D**3/6
        + (5 - 2*C1 + 28*T1 - 3*C1**2 + 8*e2/(1-e2) + 24*T1**2) * D**5/120) / math.cos(lat1)
    return math.degrees(lat), math.degrees(lon)


import re

def clean_address(address):
    """
    Turn HDB carpark addresses into something OneMap can match.
    'BLK 638-643 CHOA CHU KANG STREET 64'    -> '638 CHOA CHU KANG STREET 64'
    'BLK 659A/660A/661A CHOA CHU KANG CRES'  -> '659A CHOA CHU KANG CRESCENT'
    'BLK 302/348 ANG MO KIO STREET 31'       -> '302 ANG MO KIO STREET 31'
    """
    addr = re.sub(r'^BLK\s+|^BLOCK\s+', '', address.strip())
    # Handle ranges/slashes for both numeric (638-643) and alphanumeric (659A/660A/661A)
    addr = re.sub(r'^(\w+)[-/]\w+(?:[-/]\w+)*(?=\s)', r'\1', addr)
    return addr


async def geocode_one(client, address):
    for query in [clean_address(address), address]:
        try:
            resp = await client.get(
                "https://www.onemap.gov.sg/api/common/elastic/search",
                params={"searchVal": query, "returnGeom": "Y", "getAddrDetails": "N", "pageNum": 1},
                timeout=10,
            )
            results = resp.json().get("results", [])
            if results:
                return float(results[0]["LATITUDE"]), float(results[0]["LONGITUDE"]), "onemap"
        except Exception:
            pass
    return None, None, "failed"


async def main():
    data_file = Path(__file__).parent / "carparks.json"
    out_file  = Path(__file__).parent / "carparks_geocoded.json"

    with open(data_file) as f:
        records = json.load(f)["result"]["records"]

    output = []
    failed = 0
    svy21_fallback = 0

    async with httpx.AsyncClient() as client:
        for i, cp in enumerate(records):
            try:
                x, y = float(cp["x_coord"]), float(cp["y_coord"])
            except (ValueError, KeyError):
                continue

            lat, lon, source = await geocode_one(client, cp["address"])

            if lat is None:
                # fall back to SVY21 conversion
                if x == 0 or y == 0:
                    continue
                lat, lon = svy21_to_wgs84(x, y)
                source = "svy21"
                svy21_fallback += 1
                failed += 1

            output.append({
                "id": cp["car_park_no"],
                "address": cp["address"],
                "lat": lat,
                "lon": lon,
                "source": source,
                "free_parking": cp.get("free_parking", "NO"),
                "type": cp["car_park_type"],
            })

            if (i + 1) % 50 == 0:
                print(f"  {i+1}/{len(records)} done — {failed} fell back to SVY21")

            await asyncio.sleep(0.08)  # ~12 req/s, respectful rate

    with open(out_file, "w") as f:
        json.dump(output, f)

    print(f"\nDone. {len(output)} carparks saved.")
    print(f"  OneMap geocoded: {len(output) - svy21_fallback}")
    print(f"  SVY21 fallback:  {svy21_fallback}")
    print(f"  Output: {out_file}")


asyncio.run(main())

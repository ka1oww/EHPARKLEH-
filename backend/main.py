from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
import math
import asyncio
import json
from pathlib import Path

app = FastAPI()

app.add_middleware( #this is to allow any website or domain to make request to the backend the * helps to not restit who can call your api.
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

CENTRAL_BOUNDS = {
    "min_lat": 1.270, "max_lat": 1.320,
    "min_lon": 103.815, "max_lon": 103.880,
}

# Carpark locations are static — loaded once at startup, never re-fetched
_carpark_cache: list = [] #will be filled at startup line 81-105

def is_central(lat, lon):
    return (CENTRAL_BOUNDS["min_lat"] <= lat <= CENTRAL_BOUNDS["max_lat"] and
            CENTRAL_BOUNDS["min_lon"] <= lon <= CENTRAL_BOUNDS["max_lon"])

def svy21_to_wgs84(easting, northing): #this simply converts the data gov.sg gives us to what the map needs
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
    lat1 = (mu
            + (3*e1/2 - 27*e1**3/32) * math.sin(2*mu)
            + (21*e1**2/16 - 55*e1**4/32) * math.sin(4*mu)
            + (151*e1**3/96) * math.sin(6*mu)
            + (1097*e1**4/512) * math.sin(8*mu))

    N1 = a / math.sqrt(1 - e2 * math.sin(lat1)**2)
    T1 = math.tan(lat1)**2
    C1 = (e2 / (1 - e2)) * math.cos(lat1)**2
    R1 = a * (1 - e2) / (1 - e2 * math.sin(lat1)**2)**1.5
    D = (easting - E0) / (N1 * k0)

    lat = lat1 - (N1 * math.tan(lat1) / R1) * (
        D**2/2
        - (5 + 3*T1 + 10*C1 - 4*C1**2 - 9*e2/(1-e2)) * D**4/24
        + (61 + 90*T1 + 298*C1 + 45*T1**2 - 252*e2/(1-e2) - 3*C1**2) * D**6/720
    )
    lon = lon0 + (
        D - (1 + 2*T1 + C1) * D**3/6
        + (5 - 2*C1 + 28*T1 - 3*C1**2 + 8*e2/(1-e2) + 24*T1**2) * D**5/120
    ) / math.cos(lat1)

    return math.degrees(lat), math.degrees(lon)

def haversine(lat1, lon1, lat2, lon2): #this is to take into account the curvature of the earth
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1) * math.cos(p2) * math.sin(dl/2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@app.on_event("startup") #loads the carparks
async def load_carparks(): #async allows python3 to do other processes while waiting for this to load
    global _carpark_cache #the list that we are going to fill with the carpark information
    data_file = Path(__file__).parent / "carparks.json" #our hardcoded carpark data gets loaded on
    with open(data_file) as f: #with closes the file data_file after opening it , as f means the file is assigned to the variable f 
        records = json.load(f)["result"]["records"] #.load f reads the json fle and covers it into a python3 dictionary

    for cp in records: #this is adding the carparks into the cache
        try:
            x, y = float(cp["x_coord"]), float(cp["y_coord"])
        except (ValueError, KeyError):
            continue
        if x == 0 or y == 0:
            continue
        cp_lat, cp_lon = svy21_to_wgs84(x, y)
        _carpark_cache.append({
            "id": cp["car_park_no"],
            "address": cp["address"],
            "lat": cp_lat,
            "lon": cp_lon,
            "free_parking_info": cp.get("free_parking", "NO"),
            "type": cp["car_park_type"],
            "central": is_central(cp_lat, cp_lon),
        })
    print(f"Loaded {len(_carpark_cache)} carparks into cache.")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/suggestions")
async def suggestions(q: str = Query(...)):
    if len(q.strip()) < 2:
        return []
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://www.onemap.gov.sg/api/common/elastic/search",
            params={"searchVal": q, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": 1}
        )
    data = resp.json()
    return [
        {"address": r["ADDRESS"], "lat": float(r["LATITUDE"]), "lon": float(r["LONGITUDE"])}
        for r in data.get("results", [])[:6]
    ]


@app.get("/api/geocode") #this calls the onemap api
async def geocode(q: str = Query(...)):
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://www.onemap.gov.sg/api/common/elastic/search",
            params={"searchVal": q, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": 1}
        )
    data = resp.json()
    if not data.get("results"):
        raise HTTPException(status_code=404, detail="Location not found")
    r = data["results"][0]
    return {"lat": float(r["LATITUDE"]), "lon": float(r["LONGITUDE"]), "address": r["ADDRESS"]}


@app.get("/api/carparks")
async def get_carparks(
    lat: float = Query(...),
    lon: float = Query(...),
    radius: int = Query(500),
):
    if not _carpark_cache: #if carpark cache is empty, we need this to check because we do async so it can still be loading
        raise HTTPException(status_code=503, detail="Carpark data not loaded yet. Try again in a moment.")

    async with httpx.AsyncClient(timeout=15) as client: #this is to get the availability of the carparks
        avail_resp = await client.get("https://api.data.gov.sg/v1/transport/carpark-availability")

    avail_dict = {}
    try:
        for item in avail_resp.json()["items"][0]["carpark_data"]:
            for lot in item["carpark_info"]:
                if lot["lot_type"] == "C":
                    avail_dict[item["carpark_number"]] = {
                        "lots_available": int(lot["lots_available"]),
                        "total_lots": int(lot["total_lots"]),
                    }
    except Exception: #if the code throws an error , we can ignore it cause perhaps the data isnt given for this carpark
        pass  # availability is optional — show carparks without it

    results = []
    for cp in _carpark_cache:
        dist = haversine(lat, lon, cp["lat"], cp["lon"])
        if dist > radius: #this skips any carpark that is out of the distance
            continue

        avail = avail_dict.get(cp["id"], {"lots_available": None, "total_lots": None})
        results.append({
            "id": cp["id"],
            "address": cp["address"],
            "lat": cp["lat"],
            "lon": cp["lon"],
            "distance_m": round(dist),
            "lots_available": avail["lots_available"],
            "total_lots": avail["total_lots"],
            "type": cp["type"],
            "cost_per_30min": 1.20 if cp["central"] else 0.60,
            "zone": "central" if cp["central"] else "non-central",
            "free_parking_info": cp["free_parking_info"],
        })

    results.sort(key=lambda c: c["distance_m"]) #sorts the carparks in increasing distance
    return results

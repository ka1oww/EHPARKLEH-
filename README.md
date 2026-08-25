# EhParkLeh

I built EhParkLeh to find a car park in Singapore. Search a destination or use Near me, then compare nearby car parks by availability, rates, rules, and amenities on a map.

[Open the live app](https://ehparkleh.vercel.app).

## Data pipeline

The current dataset contains **3,566 carparks** tagged across seven sources: HDB, URA, Google, OSM, LTA, OneMotoring, and manual. A carpark can carry more than one source tag. The build records **4,465 dedupe merges**, then voids **65** records inside restricted areas, **90** outside Singapore, and **93** non-car-parking POIs. These figures are from [`backend/enrich/STATS.md`](backend/enrich/STATS.md).

```text
HDB + URA + Google + OSM + LTA + OneMotoring + manual
                            |
                  normalise and geocode
                            v
                 spatial and name deduplication
                            v
      apply restricted, boundary, and non-parking exclusions
                            v
             attach amenities, classify, and resolve rates
                            v
                 carparks_enriched.json
```

HDB and URA form the government spine. Google discovers additional locations. OSM corroborates records during deduplication and supplies a separate on-demand parking layer. LTA supplies rate and EV data, OneMotoring supplies indicative commercial rates, and manual entries cover hand-verified rates.

`fetch_gov.py` downloads HDB, URA, and LTA data. The crawlers collect Google, OSM, EV, OneMotoring, and geofence data. `build_enriched.py` preserves government IDs, folds Google and OSM records into existing records within 90 metres, or within 150 metres when names match, applies the restricted, boundary, and non-parking exclusions, attaches amenity flags, classifies records, resolves rates, and writes `carparks_enriched.json` and `STATS.md`.

Rates are attached in order: matched LTA rates, HDB/URA standard rates for eligible government car parks, OneMotoring indicative rates, then hand-curated indicative rates. Therefore the pipeline marks guide and manual rates as indicative.

Standalone OSM records are dropped from the served dataset because they produced construction-site and private noise. OSM still corroborates during deduplication, and `/api/parking/osm` supplies on-demand OSM parking at search time for unfiltered searches. While any category or amenity filter is active, the frontend excludes that unverified OSM layer from the list, map, and nearby count because OSM entries do not carry the data needed to verify those filters.

### Restricted areas

Parking inside an army camp, air or naval base, or prison exists but no driver can use it, and routing to one sends the driver to a guarded gate. [`backend/restricted.py`](backend/restricted.py) holds the single definition of restricted land, and both the build and the live `/api/parking/osm` layer filter through it, so the static dataset and the on-demand layer cannot disagree. It unions two polygon sources: URA Master Plan `SPECIAL USE` parcels from data.gov.sg (`crawl_restricted.py`), which are authoritative for MINDEF and SAF land, and OpenStreetMap `landuse=military`, `military=*` and `amenity=prison` areas (`crawl_military.py`), which cover the Home Team and police sites URA zones differently. Loading fails closed: a missing or truncated polygon set aborts the build and the boot rather than quietly filtering nothing.

Run the enrichment pipeline from `backend/` with the virtual environment active:

```bash
python enrich/fetch_gov.py
python enrich/crawl_google.py       # needs GOOGLE_PLACES_API_KEY
python enrich/crawl_osm.py
python enrich/crawl_ev.py           # needs LTA_DATAMALL_KEY
python enrich/crawl_onemotoring.py
python enrich/crawl_military.py
python enrich/crawl_restricted.py
python enrich/crawl_central_area.py
python enrich/crawl_sg_boundary.py
python enrich/build_enriched.py
```

## Honest data

Availability and EV status use stale-while-revalidate caches with a default 60-second freshness window. A fresh snapshot returns immediately. An expired last-good snapshot also returns immediately while one single-flight background refresh runs for that feed. Concurrent requests share that refresh. A failed refresh keeps the last good snapshot.

The backend sends cache state and freshness deadlines in response headers. The frontend labels values **Live** within the freshness window, **Recent** for two minutes after expiry, and **Saved** after that or while it shows retained or offline results. Hence the app never presents aged data as Live. `/api/carparks` responses use `no-store`, and saved results are labelled explicitly.

## Features

- Search by destination or Near me. Location permission is requested only when Near me is tapped.
- Address lookup failures are labelled and retryable instead of appearing as no matches; a valid search with no results stays neutral.
- Main carpark results do not wait for the supplemental OpenStreetMap layer and remain available with a quiet notice when that layer fails.
- Filter by HDB, malls, street, or private car parks, then narrow by free Sunday and public holiday parking, available lots, EV charging, car wash, or radius.
- Show resolved rates, parsed free-parking rules, lot counts, EV connector counts, and self-service car wash operators. EV site flags come from LTA DataMall, with live connector counts when the feed is configured. Car wash flags come from Beaver and QE Car Care published lists.
- Live OSM parking entries are shown for unfiltered searches; they are hidden from the list, map, and nearby count whenever a filter is active because they do not carry the filter data needed to verify a match.
- Cluster dense map markers, frame a new result set, and preserve manual map movement when availability refreshes. Selecting a card opens its map popup.
- Keep recent searches, saved favourites, shareable result URLs, and the last results for offline use. The app is an installable PWA with iOS and Android wrappers through Capacitor.

EhParkLeh finds parking. It does not handle payment, booking, or accounts.

## Run locally

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The API runs at `http://localhost:8000`. `data.gov.sg` and OneMap are keyless for serving. The committed `carparks_enriched.json` serves the static dataset. Set `LTA_DATAMALL_KEY` in `backend/.env` to add live EV connector counts.

### Frontend

```bash
cd frontend
npm install
VITE_API_BASE=http://localhost:8000 npm run dev
```

The dev server runs at `http://localhost:5173`. Run the local checks with `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` from `frontend/`, or `python -m pytest` from `backend/`. Run `python scripts/test_keep_warm_workflow.py` from the repository root to check the keep-warm workflow contract.

## Deployment

The frontend deploys to Vercel and the backend to Render. [`render.yaml`](render.yaml) records the backend service, and [`backend/build.sh`](backend/build.sh) can regenerate the dataset during a backend build. GitHub Actions runs lint, typecheck, tests, and the frontend build, plus the backend test suite.

### Backend keep-warm

Render's free plan idles the backend when it receives no traffic. [`.github/workflows/keep-warm.yml`](.github/workflows/keep-warm.yml) keeps it active with four-minute `/health` pings from a long-running job, then relaunches itself; the GitHub Actions cron is only a recovery backstop. See [`docs/keep-warm-cadence.md`](docs/keep-warm-cadence.md) for the measured failure of the former cron-only approach, the current workflow contract and resource-hour tradeoff, and the checks that remain.

## Stack

React 19, TypeScript, Vite, Leaflet, vite-plugin-pwa, Capacitor, and Vitest on the frontend. FastAPI, Pydantic, and httpx on the backend. The data sources are data.gov.sg, OpenStreetMap, Google Places API, LTA DataMall, LTA OneMotoring, and OneMap.

# EhParkLeh v2 — Build Report

Date: 2026-06-30. Branch: `v2`. Nothing was pushed or deployed; the working tree is yours to review.

This report is honest about what passed verification and what did not. Read the TODO section at the end before deploying.

## What each phase delivered

### Phase 0 — Setup
- `v2` branch created.
- Env config scaffolded: `backend/.env.example`, `frontend/.env.example`. `.env` files are git-ignored (verified).
- Dependencies installed: TypeScript, vite-plugin-pwa, Capacitor (frontend); pydantic, httpx, pytest (backend).

### Phase 1 — Data pipeline
- Pipeline built in `backend/enrich/`: `fetch_gov.py`, `crawl_google.py`, `crawl_osm.py`, `build_enriched.py`.
- Produced `backend/carparks_enriched.json` with **5,131 carparks**, each carrying id, name, address, lat/lon, geocode source, `sources`, `category`, parsed `rates`, `availability_key`, and `free_parking`.
- The original `carparks.json` and `carparks_geocoded.json` were left untouched; the enriched file is new.

### Phase 2 — Backend hardening
- `main.py` rewritten with Pydantic response models, env-driven config (no hardcoded URLs), structured logging.
- In-memory TTL cache for availability (~60s), so a search reuses the snapshot instead of re-fetching all carparks.
- Real LTA rates via `resolve_rate()`; the lat/lon bounding-box pricing hack is gone.
- Category filter parameters on `/api/carparks`.
- pytest suite added under `backend/tests/`.

### Phase 3 — Frontend
- Full TypeScript migration: `App.tsx`, `Map.tsx`, `geo.ts`, `rules.ts`, `types.ts`.
- Playful redesign with design tokens (`tokens.css`), type filters, parsed free-parking text (`rules.ts`).
- PWA via vite-plugin-pwa: web manifest, Workbox service worker, offline shell. Build precaches 21 entries (~539 KiB).
- `VITE_API_BASE` env wiring replaces the hardcoded backend URL.

### Phase 4 — Native
- Capacitor wrappers added: `frontend/android` and `frontend/ios`, `capacitor.config.ts` (`appId: sg.ehparkleh.app`).
- `geo.ts` uses the native `@capacitor/geolocation` plugin on device and the browser API on web.

### Phase 5 — Quality and docs
- `README.md` (this commit) with architecture mermaid diagram, data-pipeline doc, and run/build instructions.
- This build report.

## Data-pipeline stats

From `backend/carparks_enriched.json` and `backend/enrich/STATS.md`:

**Total carparks: 5,131**

By category:
- HDB Estate: 2,282
- Commercial/Private: 2,031
- Street (URA): 777
- Mall: 41

By source (a carpark may carry several):
- osm: 3,179
- hdb: 2,265
- ura: 777
- lta: 149

Pipeline detail:
- Spine preserved (existing geocoded ids): 2,266
- URA street parking added: 777
- OSM carparks: 3,465 in, 2,088 new ids added
- Dedupe merges (OSM folded into existing): 1,377
- LTA rates attached: 148 of 357 rate rows
- `availability_key` present on 3,043 carparks

Geocoding:
- SVY21 fallback before: 467
- SVY21 entries improved via OneMap: 217
- **SVY21 fallback remaining: 250** (down from 467)
- Geocode sources now: onemap 2,016, osm 2,088, ura 777, svy21 250

## What PASSED verification

- **Frontend production build: PASSED.** `npm run build` (tsc project build + vite build) completes with no errors. PWA service worker and manifest generated.
- **Backend tests: PASSED.** `python -m pytest` reports 14 passed.
- **Secrets hygiene: PASSED.** `backend/.env` is git-ignored (`git check-ignore` confirms); `.env.example` files committed in its place.
- **No hardcoded backend URL in the live path:** the frontend reads `VITE_API_BASE`.
- **Real rates:** `resolve_rate()` reads the LTA dataset; the bounding-box hack is removed.

## What FAILED or is INCOMPLETE

- **Google Places crawl produced 0 rows.** `backend/enrich/google_parking.json` is empty and no carpark carries `google` in its `sources`. The key was not active when the pipeline ran, so the "coverage from Google" layer did not actually contribute. Coverage in the shipped dataset comes from **gov plus OSM only**. The crawler code is in place and will populate this layer once a working key is set and `crawl_google.py` plus `build_enriched.py` are re-run. The README and CV framing describe the intended three-layer design; the current data is two layers in practice.
- **LTA rates cover 148 of 5,131 carparks.** Most carparks still have no parsed rate (only 357 rate rows exist in the LTA dataset, and 148 matched). This is a dataset-coverage limit, not a bug, but the UI will show "rate unknown" for the majority.
- **250 carparks remain on SVY21 fallback** (~100m positional error). Reduced from 467 but not eliminated.
- **iOS native is not verifiable here.** The Xcode project exists but cannot be built or signed in this environment; that needs Xcode and an Apple Developer account on your machine.
- **Android debug build not run here.** The wrapper and config exist; the APK build was not executed in this environment.
- **PWA install / offline not exercised on a real device.** The service worker generates at build time; confirm install and offline behaviour yourself via `npm run preview`.
- **Lint not part of the build gate.** `npm run lint` exists but was not enforced; run it if you want a clean lint pass.

## TODO for you on waking

1. **REGENERATE the Google Places API key.** The key was shared in chat during this build and must be treated as compromised. Create a new key in the Google Cloud Console, restrict it to Places API (New), set a daily quota cap, put it in `backend/.env` as `GOOGLE_PLACES_API_KEY`, and delete the old key. Do not commit it.
2. **Re-run the Google crawl** with the new key so the coverage layer actually populates: from `backend/`, run `python enrich/crawl_google.py` then `python enrich/build_enriched.py`, and confirm `sources` now includes `google`. Until then the dataset is gov plus OSM only.
3. **Deploy the `v2` branch.** Review the diff first, then deploy backend (Render) and frontend yourself. Nothing was auto-deployed.
4. **Finish iOS signing and the Apple Developer account.** Open `frontend/ios` in Xcode, set a signing team (requires the $99/yr Apple Developer account), and run on a device or simulator. App Store submission is a separate waking-hours task.
5. **Build and test the Android APK.** From `frontend/`, run `npx cap sync` then open Android Studio (`npx cap open android`) and build a debug APK; install it on a device to confirm native geolocation works.
6. **Review and tweak the playful redesign.** The "lovable" look is one cohesive system the agents executed; it is subjective and meant for your sign-off. Adjust tokens in `frontend/src/tokens.css` and the layout to taste.
7. **Verify PWA install and offline** via `cd frontend && npm run build && npm run preview`: install from the browser prompt, then go offline and confirm the shell and last results load.
8. **Optional polish:** run `npm run lint` and fix anything; decide whether `carparks_enriched.json` should stay committed or be generated at deploy time.

# EhParkLeh v2 — Build Plan

Status: DRAFT for sign-off. Once approved, the overnight build runs against this spec.
Date prepared: 2026-06-30.

## 1. Vision (SLC, not MVP)

One job, done completely and delightfully: **"where do I park near X, right now, that fits my needs."**

- **Simple:** finding parking only. No payment, no booking, no accounts, no social. parking.sg already owns payment; we own finding.
- **Lovable:** a distinctive redesign, a fast and smooth map, free-parking rules parsed into plain English, clear availability visuals. The incumbents are utilitarian and ugly; this is the cheapest high-leverage win.
- **Complete:** real rates (LTA dataset), full coverage (gov + OSM + Google), working type filters, installs as a PWA, wraps to iOS/Android, works offline.

## 2. Current state (from code audit, 2026-06-30)

A real, deployed app. Not a toy.

- Frontend: React 19 + Vite, react-leaflet, ~809 LOC. Search, autocomplete (OneMap), Near Me geolocation, radius filter, list + map, mobile responsive.
- Backend: FastAPI on Render, ~357 LOC, 5 endpoints. Serves 2,266 carparks; fetches live availability from data.gov.sg per search; Overpass/OSM for non-HDB parking.
- Data: 2,266 carparks bundled (LTA snapshot), geocoded via OneMap (79.3%) with SVY21 fallback (20.7%).

Known gaps to fix:
- No tests, no TypeScript, no README, backend URL hardcoded 3x in App.jsx.
- Pricing faked by a lat/lon bounding box ($1.20 central / $0.60 else) instead of real LTA rates.
- 467 carparks (20.7%) on SVY21 fallback, ~100m error.
- No availability caching (re-fetches all 2,266 per search).
- Free-parking strings shown raw, not parsed.
- Not installable, no offline, not "an app" yet.
- Render free tier sleeps (cold start ~30-50s on first hit).

## 3. Competitive positioning (for the CV)

- parking.sg (GovTech) is a payment app, not a finder: no map, no availability. Not a competitor; we fill the gap it leaves.
- The finder space is crowded (ParkIt, Parking Singapura, SG Parking, CarparkSG), all on the same free gov feed. "Shows live lots" is table stakes.
- Defensible edges, in order: (1) web-first PWA, no download wall; (2) smart type filters; (3) coverage beyond gov data via Google; (4) lovable UX.

## 4. Data architecture (three complementary layers)

| Layer | Source | Provides | Cost |
|---|---|---|---|
| Availability | data.gov.sg HDB/URA/LTA carpark-availability | Live free-lot counts | Free, keyless |
| Rates | data.gov.sg LTA Carpark Rates (d_9f6056bdb6b1dfba57f063593e4f34ae) | Real rates, replaces the bounding-box hack | Free |
| Static info | HDB Carpark Information + URA Parking Lot GeoJSON | Locations, hours, type metadata | Free |
| Coverage | Google Places API (New) Nearby Search, type=parking | Every "P" location incl. malls/private | ~$0-10 one-time |
| Long tail | OSM / Overpass amenity=parking | Free spots Google/gov miss | Free |

### The Google approach (decided)
- Use the **official Places API**, never scraping. One-time **grid crawl** of Singapore for `type=parking`. Fits the ~5,000 free calls/month tier, so effectively free, run once, refresh quarterly.
- ToS-safe pattern: Google is used to **discover** locations (name + coords + place_id). Persistent store and serving is OSM + gov. Do not build a standalone DB from Google content.
- Google gives location existence, not live availability. Availability and rates stay on the gov layer. This complementarity is the headline CV story.

### Enrichment pipeline output (the overnight heavy lift)
A single `carparks_enriched.json` where every carpark has:
- Stable id, name, lat/lon (OneMap-corrected where possible, shrinking the SVY21 467).
- `source`: hdb | ura | lta | google | osm (and merge provenance).
- `category`: HDB Estate | Mall | Commercial/Private | Street (URA) | Unclassified.
- `rates`: parsed from LTA dataset.
- `availability_key`: link to the live availability feed where one exists.
- Dedupe across sources by spatial proximity + name similarity.

Filters in the UI map directly to `category` plus live flags: [HDB] [Malls] [Street/URA] [Private] and [Free now] [Has lots] [Sheltered] [EV] where data allows.

## 5. Target architecture

- Frontend: React 19 + Vite, migrated to **TypeScript**. Leaflet kept. Add filters, parsed rules, full redesign. PWA via vite-plugin-pwa (manifest, service worker, offline shell, icons, splash).
- Native: **Capacitor** wraps the Vite build to iOS + Android. Native geolocation plugin.
- Backend: FastAPI, stays Python. Add Pydantic response models, env config (kill hardcoded URLs), structured logging, in-memory TTL cache for availability (about 60s, matching feed cadence), real rates from LTA dataset, category filter params, serve `carparks_enriched.json`.
- Config: `.env` on both sides, `.env.example` committed, no secrets in git.
- Docs: README with architecture diagram, run/deploy guide, data-pipeline doc.

## 6. Overnight workflow (phased, multi-agent)

All work on a branch `v2`, frequent commits, NEVER auto-push or auto-deploy. User reviews diffs on waking.

- **Phase 0 — Setup:** create `v2` branch, scaffold env config + `.env.example`, install deps (TypeScript, vite-plugin-pwa, Capacitor), README skeleton.
- **Phase 1 — Data pipeline (agent-heavy):** fan out crawlers (Google grid by region, OSM, gov datasets) in parallel, then merge + dedupe + classify + OneMap re-geocode. Produce `carparks_enriched.json`. Report coverage stats and any dropped/uncertain rows (no silent truncation).
- **Phase 2 — Backend hardening:** Pydantic, env config, caching, real LTA rates, category filter endpoints, logging, pytest suite.
- **Phase 3 — Frontend:** TypeScript migration, full redesign, filters UI, parsed free-parking text, PWA (manifest/SW/offline), polish, micro-interactions.
- **Phase 4 — Native:** Capacitor iOS + Android integration, native geolocation, app icons/splash, Android debug build.
- **Phase 5 — Quality + docs:** unit + integration tests, README + architecture diagram, final verification, render a screenshot of the running app.

## 7. Prerequisites the user must supply BEFORE the unattended run

Without these, agents stall.

- [ ] **Google Maps Platform API key** with Places API (New) enabled and billing turned on (stays within free tier). REQUIRED for Phase 1 Google crawl. Put in `backend/.env` as `GOOGLE_PLACES_API_KEY`.
- [ ] **OneMap access** confirmed. OneMap now requires a registered token/email+password for some endpoints; confirm current app still authenticates, or supply credentials. Put in `.env`.
- [ ] data.gov.sg: keyless, nothing needed.
- [ ] (Optional, only if we add LTA DataMall live endpoints) LTA DataMall AccountKey.
- [ ] Decide: is `V2_PLAN.md` and `carparks_enriched.json` committed to the repo, or gitignored?

## 8. Autonomy boundaries (honest)

The night is mostly hands-off, but these need you when you wake, they are not fully automatable overnight:

- **Visual redesign sign-off:** "Lovable" is subjective. Agents will execute one cohesive design system. You review and tweak on waking; we will not gamble the whole look unattended without a fallback.
- **iOS native:** Capacitor integration + Android debug build can be automated. iOS device/simulator run and signing need Xcode + an Apple Developer account ($99/yr) and your interaction. App Store / Play Store submission is a waking-hours task.
- **No auto-deploy:** nothing is pushed to GitHub or deployed to Render automatically. You review the `v2` branch diff, then deploy yourself.
- **API key safety:** keys live in `.env`, never committed. The crawl respects the free tier; a hard call cap is set so a bug cannot run up a bill.

## 9. CV framing (the story this unlocks)

"EhParkLeh: a Singapore parking-finder PWA (installable, offline-capable, wrapped to iOS/Android via Capacitor). React 19 + TypeScript + FastAPI. Architected a three-layer data pipeline: real-time availability and rates from data.gov.sg, location coverage from the Google Places API, and a long tail from OpenStreetMap, with spatial dedupe and automated type-classification powering user filters. Hybrid OneMap + SVY21 geocoding, TTL-cached availability, full test suite."

Honest, defensible, and it demonstrates build-vs-buy judgement, data engineering, and product thinking, not just "I called an API."

## 10. Definition of done

- App installs as a PWA and runs offline (cached shell + last results).
- Capacitor Android debug build runs; iOS project opens and builds in Xcode.
- Filters work against real `category` data.
- Rates come from the LTA dataset, the bounding-box hack is gone.
- SVY21 fallback count meaningfully reduced.
- Availability is cached, no full re-fetch per search.
- TypeScript on the frontend, Pydantic on the backend, env config, no hardcoded URLs.
- Tests pass. README + architecture diagram exist.
- All on branch `v2`, reviewed by user, nothing auto-deployed.

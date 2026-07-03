# Enriched Carpark Dataset — Stats

Generated: 2026-07-03 16:39:31

**Total carparks:** 3639

## By category

- HDB Estate: 2265
- Street (URA): 775
- Commercial/Private: 510
- Mall: 89

## By source (carparks tagged with each source)

- hdb: 2264
- google: 2120
- osm: 1864
- ura: 775
- lta: 202
- onemotoring: 47

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 2764 -> new ids added: 744
- OSM carparks (input): 3465 -> new ids added: 1020
- Dedupe merges (Google/OSM folded into existing): 4465
- Dedupe policy: gov authoritative; fold within 90m proximity, or 150m when names match
- Voided inside military areas (199 camps/bases): 54
- Voided outside Singapore (Johor etc.): 90
- Dropped standalone OSM carparks: 977
- Voided from manual_voids.json (Google junk/condos + flagged): 47
- LTA rates attached: 200 (of 357 rate rows)
- HDB/URA standard rates applied: 2783
- Carparks flagged with EV charging: 2133 (of 2706 EV sites)
- OneMotoring indicative rates attached: 47

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 0
- SVY21 fallback remaining: 0

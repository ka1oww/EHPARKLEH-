# Enriched Carpark Dataset — Stats

Generated: 2026-07-02 11:47:58

**Total carparks:** 3725

## By category

- HDB Estate: 2265
- Street (URA): 775
- Commercial/Private: 587
- Mall: 98

## By source (carparks tagged with each source)

- hdb: 2264
- google: 2206
- osm: 1895
- ura: 775
- lta: 205

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 2764 -> new ids added: 744
- OSM carparks (input): 3465 -> new ids added: 1020
- Dedupe merges (Google/OSM folded into existing): 4465
- Dedupe policy: gov authoritative; fold within 90m proximity, or 150m when names match
- Voided inside military areas (199 camps/bases): 54
- Dropped standalone OSM carparks: 977
- Voided from manual_voids.json (Google junk/condos + flagged): 51
- LTA rates attached: 203 (of 357 rate rows)
- HDB/URA standard rates applied: 2783

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 0
- SVY21 fallback remaining: 0

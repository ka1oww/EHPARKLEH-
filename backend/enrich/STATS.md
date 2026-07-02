# Enriched Carpark Dataset — Stats

Generated: 2026-07-02 09:39:57

**Total carparks:** 4753

## By category

- HDB Estate: 2274
- Commercial/Private: 1582
- Street (URA): 776
- Mall: 121

## By source (carparks tagged with each source)

- osm: 2884
- hdb: 2264
- google: 2256
- ura: 776
- lta: 220

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 2764 -> new ids added: 744
- OSM carparks (input): 3465 -> new ids added: 1020
- Dedupe merges (Google/OSM folded into existing): 4465
- Dedupe policy: gov authoritative; fold within 90m proximity, or 150m when names match
- Voided inside military areas (199 camps/bases): 54
- LTA rates attached: 218 (of 357 rate rows)

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 0
- SVY21 fallback remaining: 0

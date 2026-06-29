# Enriched Carpark Dataset — Stats

Generated: 2026-06-30 01:43:21

**Total carparks:** 5131

## By category

- HDB Estate: 2282
- Commercial/Private: 2031
- Street (URA): 777
- Mall: 41

## By source (carparks tagged with each source)

- osm: 3179
- hdb: 2265
- ura: 777
- lta: 149

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 0 -> new ids added: 0
- OSM carparks (input): 3465 -> new ids added: 2088
- Dedupe merges (Google/OSM folded into existing): 1377
- LTA rates attached: 148 (of 357 rate rows)

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 217
- SVY21 fallback remaining: 250

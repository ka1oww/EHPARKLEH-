# Enriched Carpark Dataset — Stats

Generated: 2026-06-30 14:00:53

**Total carparks:** 5906

## By category

- Commercial/Private: 2733
- HDB Estate: 2280
- Street (URA): 777
- Mall: 116

## By source (carparks tagged with each source)

- osm: 2825
- hdb: 2265
- google: 2147
- ura: 777
- lta: 227

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 2764 -> new ids added: 1630
- OSM carparks (input): 3465 -> new ids added: 1233
- Dedupe merges (Google/OSM folded into existing): 3366
- Dedupe policy: gov authoritative; fold within 90m proximity, or 150m when names match
- LTA rates attached: 226 (of 357 rate rows)

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 0
- SVY21 fallback remaining: 0

# Enriched Carpark Dataset — Stats

Generated: 2026-06-30 08:46:15

**Total carparks:** 6794

## By category

- Commercial/Private: 3558
- HDB Estate: 2283
- Street (URA): 777
- Mall: 176

## By source (carparks tagged with each source)

- osm: 3176
- google: 2719
- hdb: 2265
- ura: 777
- lta: 285

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 2764 -> new ids added: 2065
- OSM carparks (input): 3465 -> new ids added: 1686
- Dedupe merges (Google/OSM folded into existing): 2478
- LTA rates attached: 284 (of 357 rate rows)

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 217
- SVY21 fallback remaining: 250

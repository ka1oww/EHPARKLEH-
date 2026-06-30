# Enriched Carpark Dataset — Stats

Generated: 2026-06-30 09:52:32

**Total carparks:** 5062

## By category

- HDB Estate: 2274
- Commercial/Private: 1892
- Street (URA): 777
- Mall: 119

## By source (carparks tagged with each source)

- osm: 2901
- hdb: 2265
- google: 2233
- ura: 777
- lta: 222

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 2764 -> new ids added: 976
- OSM carparks (input): 3465 -> new ids added: 1043
- Dedupe merges (Google/OSM folded into existing): 4210
- Dedupe policy: gov authoritative; fold within 90m proximity, or 150m when names match
- LTA rates attached: 221 (of 357 rate rows)

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 217
- SVY21 fallback remaining: 250

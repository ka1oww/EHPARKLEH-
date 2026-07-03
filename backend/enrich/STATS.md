# Enriched Carpark Dataset — Stats

Generated: 2026-07-03 16:51:49

**Total carparks:** 3613

## By category

- HDB Estate: 2260
- Street (URA): 770
- Commercial/Private: 498
- Mall: 85

## By source (carparks tagged with each source)

- hdb: 2259
- google: 2096
- osm: 1855
- ura: 770
- lta: 200
- onemotoring: 47
- manual: 8

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 2764 -> new ids added: 744
- OSM carparks (input): 3465 -> new ids added: 1020
- Dedupe merges (Google/OSM folded into existing): 4465
- Dedupe policy: gov authoritative; fold within 90m proximity, or 150m when names match
- Voided inside military areas (199 camps/bases): 54
- Voided outside Singapore (Johor etc.): 90
- Voided non-car-parking POIs (delivery/bike/bus/etc.): 56
- Dropped standalone OSM carparks: 977
- Voided from manual_voids.json (Google junk/condos + flagged): 17
- LTA rates attached: 198 (of 357 rate rows)
- HDB/URA standard rates applied: 2775
- Carparks flagged with EV charging: 2122 (of 2706 EV sites)
- OneMotoring indicative rates attached: 47
- Hand-curated indicative rates attached: 8

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 0
- SVY21 fallback remaining: 0

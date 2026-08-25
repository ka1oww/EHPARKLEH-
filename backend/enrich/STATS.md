# Enriched Carpark Dataset: Stats

Generated: 2026-08-25 10:49:00

**Total carparks:** 3566

## By category

- HDB Estate: 2275
- Street (URA): 742
- Commercial/Private: 467
- Mall: 82

## By source (carparks tagged with each source)

- hdb: 2259
- google: 2054
- osm: 1829
- ura: 742
- lta: 125
- onemotoring: 54
- manual: 8

## Pipeline

- Spine (existing geocoded ids preserved): 2266
- URA street parking added: 777
- Google-discovered carparks (input): 2764 -> new ids added: 744
- OSM carparks (input): 3465 -> new ids added: 1020
- Dedupe merges (Google/OSM folded into existing): 4465
- Dedupe policy: gov authoritative; fold within 90m proximity, or 150m when names match
- Voided inside restricted areas (211 camps/bases/prisons): 65
- Voided outside Singapore (Johor etc.): 90
- Voided non-car-parking POIs (delivery/bike/bus/etc.): 93
- Voided business/private/restricted POIs: 18
- Dropped standalone OSM carparks: 967
- Voided from manual_voids.json (Google junk/condos + flagged): 8
- LTA rates attached: 123 (of 357 rate rows)
- HDB/URA standard rates applied: 2815
- Carparks flagged with EV charging: 2121 (of 2706 EV sites)
- Carparks flagged with a self-service car wash: 433
- OneMotoring indicative rates attached: 54
- Hand-curated indicative rates attached: 8

## Geocoding

- SVY21 fallback before: 467
- OneMap re-geocode attempts: 0 (rest cached)
- OneMap transient failures (not cached, retry next run): 0
- SVY21 entries improved via OneMap: 0
- SVY21 fallback remaining: 0

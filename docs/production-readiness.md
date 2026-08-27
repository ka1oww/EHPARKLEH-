# Production search readiness

## Deployed topology

The production search path is:

1. `https://ehparkleh.vercel.app` serves the Vite/React PWA from `frontend/`.
2. The browser calls `https://ehparkleh-backend.onrender.com` directly.
3. Render runs `backend/main.py` with Uvicorn and the committed static carpark dataset.
4. `/api/carparks` joins data.gov.sg availability and configured LTA EV status onto that dataset. `/api/parking/osm` is a separate, optional Overpass layer.

Both deployments follow `main`. For PR #4 (`67e8e8a`), GitHub reported the Vercel production deployment successful at 2026-08-09 10:40:45 UTC. The public Render process began at 10:41:18 UTC and exposed the PR #4-only timing fields, confirming that code was live. `render.yaml` records a free-plan, auto-deploy service, but the live service is manually managed and its dashboard-only plan/branch fields were not independently readable during this audit. No provider setting or plan was changed.

## Reproduce safely

Run from the repository root:

```bash
./scripts/smoke-production.py --samples 5
```

The command uses fixed central-Singapore coordinates, sends read-only GETs, and records only response counts plus safe phase/cache/process timing. It does not collect a person's location, response records, credentials, or provider logs.

Read each sample as follows:

| Condition | Evidence |
| --- | --- |
| Newly started/sleeping process | A new process description with very low `process_uptime`; client time can include edge routing and process startup that `total` does not. Do not call it a sleep wake from duration alone. |
| Awake process, empty application caches | Established process uptime plus `availability=empty:awaited-*` and/or `ev=empty:awaited-*`; `total` tracks the awaited feed. |
| Warm request | Feed states `hit:none`; `total` is local filtering plus small overhead. |
| Expired snapshot | `stale:background-scheduled` or `stale:background-inflight`; the response is immediate and the UI labels the values `Recent`. |
| Upstream failure with a last-good snapshot | The same stale fast path continues; application logs record a failure class and `cache_retained=true`. |
| Empty-cache upstream failure | The request completes after the bounded upstream attempt with no fabricated live values. Backend tests cover this without disrupting production. |

Use the process boot identifier only to correlate samples. It contains no host, account, or credential data.

## Evidence snapshot: 2026-08-09

These are small diagnostic samples, not an availability SLO or population latency claim.

| Case | Browser/runner time | Server timing | Interpretation |
| --- | ---: | ---: | --- |
| Prior active-process diagnosis before PR #4 | about 5.5-6.1 s | upstream wait dominated | Baseline supplied by the preceding investigation. |
| PR #4 deployed, process awake 355.5 s, caches empty | 4,028 ms browser resource | 3,409 ms total; availability 2,652 ms; EV 3,397.5 ms | Not a Render wake. The deployment had not seeded live caches, so the first user awaited both feeds. |
| Warm PR #4, five browser samples | 283-377 ms, median 303 ms | 3.9-7.6 ms total | Network/browser overhead dominated. Sample size is only five. |
| Expired PR #4 snapshot | 384 ms browser | 5.5 ms total; both feeds `stale:background-scheduled` | Confirms the counterfactual: removing upstream waits from the active-process stale path returns useful results quickly. |
| Five-sample CLI smoke later in the same process | 417-985 ms, median 892 ms | 2.9-4.5 ms total | High runner-network variance; server path stayed fast while refresh moved stale feeds to hits. |

The first production page load also issued a second identical search pair after 251 ms, aborting the first browser requests. This was a mount-time filter-effect retry, not polling. The frontend has no periodic search poll.

After this change, a production build was exercised against a controlled local substitute with a 200 ms primary response and a 3,000 ms OSM response. On a radius search, the primary request took 215 ms and results became visible 216 ms after the loading transition while OSM was still pending. This controlled comparison proves request orchestration, not a production latency claim. Production after-timings must be recorded again after this branch deploys.

## What changed where

PR #4 fixed the backend's active-process path: stale-while-revalidate availability/EV snapshots, single-flight background refreshes, a shared HTTP client, concurrent empty-feed fetches, last-good retention, and safe timing/cache/process telemetry.

This production-readiness change adds:

- non-blocking feed priming at application startup and on `/health`, using PR #4's single-flight tasks;
- one initial frontend request instead of an abort/retry pair;
- primary results that render without waiting for optional OSM, with a fifteen-second OSM client bound (sized to outlast the backend's serial Overpass mirror fallback; see `OSM_TIMEOUT_MS` in `frontend/src/App.tsx`);
- causal-neutral slow copy instead of guessing that Render is waking;
- per-feed cache-state and snapshot freshness-deadline response headers, with
  `Live`, `Recent`, or `Saved` labels that downgrade as snapshots age;
- no service-worker caching of live search API responses, preventing a failed
  request from becoming an unlabelled cached success; and
- visible saved results during a slow refresh, plus controlled regression tests.

Successful response bodies remain compatible. Diagnostics stay in headers,
failure states use non-2xx responses, and `/health` retains its existing JSON
shape.

Address and supplemental-map failures have separate contracts. A valid empty
OneMap response is a no-match; timeouts, upstream errors, and unusable response
shapes return an error so the interface can offer a retry. The optional
Overpass request never blocks primary carpark results: on failure the backend
falls back through multiple mirrors, then a cache covering the requested area
(`X-EhParkLeh-Osm-State: stale`), then the OSM crawl committed at
`backend/enrich/osm_parking.json` (`X-EhParkLeh-Osm-State: snapshot`), before
finally returning an error. Both cache tiers are filled only by a *successful*
Overpass fetch, so on a cold process — the normal state on a free Render plan,
which spins down after ~15 min idle — they are empty and cannot cover an
upstream outage; the committed crawl ships with the build and can, which is why
it is the floor. A stale or snapshot response is served as real data with no
user-visible notice, and the supplemental-layer notice now appears only if the
crawl itself is missing or truncated. See the `OVERPASS_ENDPOINTS`,
`_overpass_cooldown` and `OSM_SNAPSHOT_FILE` comments in `backend/main.py` for
the mirror, cooldown and snapshot mechanics.

`X-EhParkLeh-Availability-Fresh-Until` and `X-EhParkLeh-Ev-Fresh-Until` are
fixed when each successful snapshot is published, rather than regenerated for
each response. A snapshot is `Live` only before its deadline, `Recent` for up
to two minutes after expiry, then `Saved`. Retained results are also `Saved`
while the browser is offline or after a later carpark request fails. A failed
address lookup is not one: it is reported as an error, and results already on
screen keep their live labelling. `Recent` describes snapshot age and does not
by itself claim that a refresh is running.

## Remaining external or unverified stages

- A genuine Render sleep wake was not induced during this task; the keep-warm workflow (then a five-minute cron) was succeeding, and deliberately stopping it or the service would have created an artificial outage. The observed 10:41 process boot followed a deployment, not a proven sleep wake. A real cold start was measured later in the separate [keep-warm reliability work](keep-warm-cadence.md).
- Provider edge/network time remains variable and is outside application `total`.
- Keep-warm reliability is tracked separately. The former five-minute cron has been replaced by a self-relaunching Actions job; [`keep-warm-cadence.md`](keep-warm-cadence.md) owns the current mechanism, measurements, and remaining verification limits.
- The current task's production behavior remains unverified until its own deployment completes. Use the smoke command and browser timing before claiming success.

## Demo video storyboard

Record only after the branch has passed review, merged, deployed, and the production smoke succeeds.

1. Show the production URL and search the fixed Bras Basah coordinates or a typed public destination.
2. Show primary carpark cards appearing, then point out that optional OSM pins may arrive separately without blocking the list.
3. Open the carpark request in DevTools and show `Server-Timing`, the process uptime, and the two cache states without showing response records.
4. Trigger an expired snapshot after the TTL and show a fast response labelled `Recent`, then a later `hit` sample from the smoke command.
5. Demonstrate the saved-results fallback offline and point out the `Saved` label instead of `Live`.
6. End with the smoke summary and state the sample count. If the deployed timings or labels do not match, stop the recording and investigate rather than presenting it as successful.

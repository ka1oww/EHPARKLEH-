"""Backend hardening tests: data, filtering, and live-feed cache behavior."""

import asyncio
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock

import pytest

# Make `backend` importable regardless of where pytest is invoked from.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402

FAST_PATH_TIMEOUT = 0.25
ASYNC_TEST_TIMEOUT = 1.0


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def loaded_cache():
    """Load the real dataset into main._carpark_cache once for the module."""
    main._carpark_cache = main.load_carpark_records()
    return main._carpark_cache


@pytest.fixture(autouse=True)
async def reset_live_caches():
    """Give every test empty caches and clean up background refresh tasks."""

    async def cancel_refreshes():
        tasks = [
            task
            for task in (main._avail_refresh_task, main._ev_refresh_task)
            if task is not None and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    await cancel_refreshes()
    main._avail_refresh_task = None
    main._ev_refresh_task = None
    main._avail_cache = {"data": None, "fetched_at": 0.0}
    main._ev_avail_cache = {"data": None, "fetched_at": 0.0}
    yield
    await cancel_refreshes()
    main._avail_refresh_task = None
    main._ev_refresh_task = None


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def test_data_loads(loaded_cache):
    assert len(loaded_cache) > 1000
    sample = loaded_cache[0]
    for key in ("id", "address", "lat", "lon", "availability_key"):
        assert key in sample


def test_categories_are_public_filter_values(loaded_cache):
    cats = {cp["category"] for cp in loaded_cache if cp["category"] is not None}
    assert cats.issubset({"HDB", "Mall", "Street", "Private"})


def test_category_mapping():
    assert main.to_filter_category("HDB Estate") == "HDB"
    assert main.to_filter_category("Commercial/Private") == "Private"
    assert main.to_filter_category("Street (URA)") == "Street"
    assert main.to_filter_category("Mall") == "Mall"
    assert main.to_filter_category(None) is None


# ---------------------------------------------------------------------------
# Rates resolution (no more bounding-box fake prices)
# ---------------------------------------------------------------------------
def test_rates_unknown_when_missing():
    r = main.resolve_rate(None)
    assert r.known is False
    assert r.summary == "unknown"
    assert r.first_hour is None


def test_rates_resolved_from_parsed_blob():
    rates = {
        "category": "South & CBD",
        "rates": {
            "weekday_1": {
                "raw": "6am-5pm: $2.20 for 1st hr; $1.10 for sub. half hr",
                "first_hour": 2.2,
                "subsequent_half_hour": 1.1,
            },
            "saturday": {"raw": "Same as wkdays"},
            "sunday_publicholiday": {"raw": "$3.50 per entry"},
        },
    }
    r = main.resolve_rate(rates)
    assert r.known is True
    assert r.first_hour == 2.2
    assert r.subsequent_half_hour == 1.1
    assert "2.20" in r.summary
    assert r.sunday_ph_raw == "$3.50 per entry"


def test_rates_raw_only_still_known():
    rates = {"rates": {"weekday_1": {"raw": "$1.00 per entry"}}}
    r = main.resolve_rate(rates)
    assert r.known is True
    assert r.summary == "$1.00 per entry"
    assert r.first_hour is None


# ---------------------------------------------------------------------------
# Category + flag filtering
# ---------------------------------------------------------------------------
def _build_cache():
    return [
        {
            "id": "A",
            "name": "HDB one",
            "address": "addr A",
            "lat": 1.3000,
            "lon": 103.8000,
            "type": "MULTI-STOREY",
            "category": "HDB",
            "rates": None,
            "free_parking_info": "SUN & PH FR 7AM-10.30PM",
            "availability_key": "A",
            "sources": ["hdb"],
        },
        {
            "id": "B",
            "name": "Mall two",
            "address": "addr B",
            "lat": 1.3001,
            "lon": 103.8001,
            "type": "BASEMENT",
            "category": "Mall",
            "rates": None,
            "free_parking_info": "NO",
            "availability_key": "B",
            "sources": ["ura"],
        },
        {
            "id": "C",
            "name": "Far away",
            "address": "addr C",
            "lat": 1.4000,
            "lon": 103.9000,
            "type": "SURFACE",
            "category": "HDB",
            "rates": None,
            "free_parking_info": None,
            "availability_key": "C",
            "sources": ["hdb"],
        },
    ]


def test_radius_filtering(monkeypatch):
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    out = main.filter_carparks(1.3000, 103.8000, radius=500, availability={})
    ids = {c.id for c in out}
    assert "C" not in ids  # far carpark excluded
    assert {"A", "B"} == ids


def test_category_filtering(monkeypatch):
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    out = main.filter_carparks(1.3000, 103.8000, radius=500, availability={}, category="Mall")
    assert {c.id for c in out} == {"B"}


def test_free_sun_ph_filtering(monkeypatch):
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    out = main.filter_carparks(1.3000, 103.8000, radius=500, availability={}, free_sun_ph=True)
    # Only A has a non-"NO" free_parking string within range.
    assert {c.id for c in out} == {"A"}


def test_has_lots_filtering(monkeypatch):
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    availability = {"A": {"lots_available": 10, "total_lots": 100}, "B": {"lots_available": 0, "total_lots": 50}}
    out = main.filter_carparks(1.3000, 103.8000, radius=500, availability=availability, has_lots=True)
    assert {c.id for c in out} == {"A"}
    a = next(c for c in out if c.id == "A")
    assert a.lots_available == 10
    assert a.total_lots == 100


def test_results_sorted_by_distance(monkeypatch):
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    out = main.filter_carparks(1.3000, 103.8000, radius=2000, availability={})
    dists = [c.distance_m for c in out]
    assert dists == sorted(dists)


# ---------------------------------------------------------------------------
# Availability TTL cache (httpx mocked)
# ---------------------------------------------------------------------------
SAMPLE_FEED = {
    "items": [
        {
            "carpark_data": [
                {
                    "carpark_number": "A",
                    "carpark_info": [
                        {"lot_type": "C", "lots_available": "42", "total_lots": "100"},
                        {"lot_type": "M", "lots_available": "5", "total_lots": "10"},
                    ],
                },
                {
                    "carpark_number": "B",
                    "carpark_info": [
                        {"lot_type": "C", "lots_available": "0", "total_lots": "50"},
                    ],
                },
            ]
        }
    ]
}


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeClient:
    """Counts how many GETs are made so we can assert on caching."""

    calls = 0

    async def get(self, url, **_kwargs):
        _FakeClient.calls += 1
        return _FakeResponse(SAMPLE_FEED)


@pytest.mark.asyncio
async def test_availability_parse_and_cache():
    _FakeClient.calls = 0
    client = _FakeClient()

    first = await main.get_availability(client=client)
    assert first["A"] == {"lots_available": 42, "total_lots": 100}
    assert first["B"]["lots_available"] == 0
    assert "M" not in first  # motorcycle lots dropped
    assert _FakeClient.calls == 1

    # Second call within TTL must NOT hit the network again.
    second = await main.get_availability(client=client)
    assert second == first
    assert _FakeClient.calls == 1


@pytest.mark.asyncio
async def test_availability_hit_is_fast_and_does_not_refresh():
    snapshot = {"A": {"lots_available": 8, "total_lots": 20}}
    fresh_until = time.time() + main.AVAILABILITY_TTL_SECONDS
    main._avail_cache = {
        "data": snapshot,
        "fetched_at": time.monotonic(),
        "fresh_until": fresh_until,
    }

    class _ExplodingClient:
        calls = 0

        async def get(self, url, **_kwargs):
            self.calls += 1
            raise AssertionError(f"unexpected refresh: {url}")

    client = _ExplodingClient()
    timing = main.CacheTiming()
    started = time.perf_counter()
    out = await asyncio.wait_for(
        main.get_availability(client=client, timing=timing),
        timeout=FAST_PATH_TIMEOUT,
    )

    assert out is snapshot
    assert client.calls == 0
    assert timing.state == "hit"
    assert timing.refresh == "none"
    assert timing.fresh_until == fresh_until
    assert (time.perf_counter() - started) < FAST_PATH_TIMEOUT


class _BlockingAvailabilityClient:
    def __init__(self, payload=SAMPLE_FEED, *, fail=False):
        self.payload = payload
        self.fail = fail
        self.calls = 0
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def get(self, _url, **_kwargs):
        self.calls += 1
        self.started.set()
        await self.release.wait()
        if self.fail:
            raise RuntimeError("availability unavailable")
        return _FakeResponse(self.payload)


def _expired(snapshot):
    return {
        "data": snapshot,
        "fetched_at": time.monotonic() - main.AVAILABILITY_TTL_SECONDS - 1,
        "fresh_until": time.time() - 1,
    }


@pytest.mark.asyncio
async def test_stale_availability_returns_without_waiting_for_slow_upstream():
    stale = {"OLD": {"lots_available": 1, "total_lots": 2}}
    old_cache = _expired(stale)
    main._avail_cache = old_cache
    client = _BlockingAvailabilityClient()
    timing = main.CacheTiming()

    out = await asyncio.wait_for(
        main.get_availability(client=client, timing=timing),
        timeout=FAST_PATH_TIMEOUT,
    )
    assert out is stale
    assert timing.state == "stale"
    assert timing.refresh == "background-scheduled"
    assert main._avail_cache is old_cache

    await asyncio.wait_for(client.started.wait(), timeout=ASYNC_TEST_TIMEOUT)
    refresh = main._avail_refresh_task
    assert refresh is not None and not refresh.done()
    client.release.set()
    assert await asyncio.wait_for(refresh, timeout=ASYNC_TEST_TIMEOUT) is True
    assert main._avail_cache is not old_cache
    assert main._avail_cache["data"]["A"]["lots_available"] == 42


@pytest.mark.asyncio
async def test_concurrent_stale_availability_requests_start_one_refresh():
    stale = {"OLD": {"lots_available": 1, "total_lots": 2}}
    main._avail_cache = _expired(stale)
    client = _BlockingAvailabilityClient()

    results = await asyncio.wait_for(
        asyncio.gather(*(main.get_availability(client=client) for _ in range(20))),
        timeout=FAST_PATH_TIMEOUT,
    )
    assert all(result is stale for result in results)
    await asyncio.wait_for(client.started.wait(), timeout=ASYNC_TEST_TIMEOUT)
    assert client.calls == 1

    refresh = main._avail_refresh_task
    assert refresh is not None
    client.release.set()
    await asyncio.wait_for(refresh, timeout=ASYNC_TEST_TIMEOUT)
    assert client.calls == 1


@pytest.mark.asyncio
async def test_failed_availability_refresh_retains_last_good_snapshot():
    stale = {"A": {"lots_available": 7, "total_lots": 10}}
    old_cache = _expired(stale)
    main._avail_cache = old_cache
    client = _BlockingAvailabilityClient(fail=True)

    assert await main.get_availability(client=client) is stale
    await asyncio.wait_for(client.started.wait(), timeout=ASYNC_TEST_TIMEOUT)
    refresh = main._avail_refresh_task
    assert refresh is not None
    client.release.set()
    assert await asyncio.wait_for(refresh, timeout=ASYNC_TEST_TIMEOUT) is False
    assert main._avail_cache is old_cache
    assert main._avail_cache["data"] is stale


@pytest.mark.asyncio
async def test_availability_timeout_retains_last_good_snapshot():
    stale = {"A": {"lots_available": 7, "total_lots": 10}}
    old_cache = _expired(stale)
    main._avail_cache = old_cache

    class _TimeoutClient:
        async def get(self, _url, **_kwargs):
            raise main.httpx.ReadTimeout("controlled test timeout")

    assert await main.get_availability(client=_TimeoutClient()) is stale
    refresh = main._avail_refresh_task
    assert refresh is not None
    assert await asyncio.wait_for(refresh, timeout=ASYNC_TEST_TIMEOUT) is False
    assert main._avail_cache is old_cache
    assert main._avail_cache["data"] is stale


@pytest.mark.asyncio
async def test_empty_availability_waits_for_first_snapshot_and_is_bounded():
    client = _BlockingAvailabilityClient()
    request = asyncio.create_task(main.get_availability(client=client))

    await asyncio.wait_for(client.started.wait(), timeout=ASYNC_TEST_TIMEOUT)
    assert not request.done()
    client.release.set()
    out = await asyncio.wait_for(request, timeout=ASYNC_TEST_TIMEOUT)
    assert out["A"] == {"lots_available": 42, "total_lots": 100}
    assert client.calls == 1


@pytest.mark.asyncio
async def test_empty_availability_failure_returns_empty_map():
    client = _BlockingAvailabilityClient(fail=True)
    request = asyncio.create_task(main.get_availability(client=client))

    await asyncio.wait_for(client.started.wait(), timeout=ASYNC_TEST_TIMEOUT)
    client.release.set()
    assert await asyncio.wait_for(request, timeout=ASYNC_TEST_TIMEOUT) == {}


EV_META = {"value": [{"Link": "https://example.test/ev-status.json"}]}
EV_FEED = {
    "evLocationsData": [
        {
            "chargingPoints": [
                {"plugTypes": [{"evIds": [{"evCpId": "EV1", "status": "1"}]}]}
            ]
        }
    ]
}


class _BlockingEVClient:
    def __init__(self, *, fail=False):
        self.fail = fail
        self.calls = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def get(self, url, **_kwargs):
        self.calls.append(url)
        if url == main.EVC_BATCH_URL:
            self.started.set()
            await self.release.wait()
            if self.fail:
                raise RuntimeError("ev unavailable")
            return _FakeResponse(EV_META)
        return _FakeResponse(EV_FEED)


@pytest.mark.asyncio
async def test_ev_hit_does_not_refresh(monkeypatch):
    monkeypatch.setattr(main, "LTA_DATAMALL_KEY", "test-key")
    snapshot = {"EV1": "1"}
    fresh_until = time.time() + main.EV_AVAILABILITY_TTL_SECONDS
    main._ev_avail_cache = {
        "data": snapshot,
        "fetched_at": time.monotonic(),
        "fresh_until": fresh_until,
    }
    client = _BlockingEVClient()
    timing = main.CacheTiming()

    out = await asyncio.wait_for(
        main.get_ev_availability(client=client, timing=timing),
        timeout=FAST_PATH_TIMEOUT,
    )
    assert out is snapshot
    assert client.calls == []
    assert timing.state == "hit"
    assert timing.refresh == "none"
    assert timing.fresh_until == fresh_until


@pytest.mark.asyncio
async def test_concurrent_stale_ev_requests_start_one_two_step_refresh(monkeypatch):
    monkeypatch.setattr(main, "LTA_DATAMALL_KEY", "test-key")
    stale = {"OLD-EV": "0"}
    old_cache = {
        "data": stale,
        "fetched_at": time.monotonic() - main.EV_AVAILABILITY_TTL_SECONDS - 1,
        "fresh_until": time.time() - 1,
    }
    main._ev_avail_cache = old_cache
    client = _BlockingEVClient()

    results = await asyncio.wait_for(
        asyncio.gather(*(main.get_ev_availability(client=client) for _ in range(20))),
        timeout=FAST_PATH_TIMEOUT,
    )
    assert all(result is stale for result in results)
    await asyncio.wait_for(client.started.wait(), timeout=ASYNC_TEST_TIMEOUT)
    assert client.calls == [main.EVC_BATCH_URL]
    assert main._ev_avail_cache is old_cache

    refresh = main._ev_refresh_task
    assert refresh is not None
    client.release.set()
    assert await asyncio.wait_for(refresh, timeout=ASYNC_TEST_TIMEOUT) is True
    assert client.calls == [main.EVC_BATCH_URL, "https://example.test/ev-status.json"]
    assert main._ev_avail_cache is not old_cache
    assert main._ev_avail_cache["data"] == {"EV1": "1"}


@pytest.mark.asyncio
async def test_failed_ev_refresh_retains_last_good_snapshot(monkeypatch):
    monkeypatch.setattr(main, "LTA_DATAMALL_KEY", "test-key")
    stale = {"OLD-EV": "1"}
    old_cache = {
        "data": stale,
        "fetched_at": time.monotonic() - main.EV_AVAILABILITY_TTL_SECONDS - 1,
        "fresh_until": time.time() - 1,
    }
    main._ev_avail_cache = old_cache
    client = _BlockingEVClient(fail=True)

    assert await main.get_ev_availability(client=client) is stale
    await asyncio.wait_for(client.started.wait(), timeout=ASYNC_TEST_TIMEOUT)
    refresh = main._ev_refresh_task
    assert refresh is not None
    client.release.set()
    assert await asyncio.wait_for(refresh, timeout=ASYNC_TEST_TIMEOUT) is False
    assert main._ev_avail_cache is old_cache
    assert main._ev_avail_cache["data"] is stale


@pytest.mark.asyncio
async def test_ev_without_key_is_disabled_without_refresh(monkeypatch):
    monkeypatch.setattr(main, "LTA_DATAMALL_KEY", "")
    client = _BlockingEVClient()
    timing = main.CacheTiming()

    assert await main.get_ev_availability(client=client, timing=timing) == {}
    assert client.calls == []
    assert timing.state == "disabled"


class _IndependentFeedsClient:
    def __init__(self, failing_phase):
        self.failing_phase = failing_phase

    async def get(self, url, **_kwargs):
        if url == main.AVAILABILITY_URL:
            if self.failing_phase == "availability":
                raise RuntimeError("availability failed")
            return _FakeResponse(SAMPLE_FEED)
        if url == main.EVC_BATCH_URL:
            if self.failing_phase == "ev":
                raise RuntimeError("ev failed")
            return _FakeResponse(EV_META)
        return _FakeResponse(EV_FEED)


@pytest.mark.asyncio
@pytest.mark.parametrize("failing_phase", ["availability", "ev"])
async def test_feed_failures_are_independent(monkeypatch, failing_phase):
    monkeypatch.setattr(main, "LTA_DATAMALL_KEY", "test-key")
    client = _IndependentFeedsClient(failing_phase)
    availability, ev = await asyncio.wait_for(
        asyncio.gather(
            main.get_availability(client=client),
            main.get_ev_availability(client=client),
        ),
        timeout=ASYNC_TEST_TIMEOUT,
    )

    if failing_phase == "availability":
        assert availability == {}
        assert ev == {"EV1": "1"}
    else:
        assert availability["A"]["lots_available"] == 42
        assert ev == {}


@pytest.mark.asyncio
async def test_cache_priming_is_non_blocking_and_single_flight(monkeypatch):
    monkeypatch.setattr(main, "LTA_DATAMALL_KEY", "test-key")
    client = _IndependentFeedsClient(failing_phase=None)

    first = main.prime_live_feed_caches(trigger="test", client=client)
    availability_task = main._avail_refresh_task
    ev_task = main._ev_refresh_task
    second = main.prime_live_feed_caches(trigger="test", client=client)

    assert first == {"availability": "empty", "ev": "empty"}
    assert second == first
    assert main._avail_refresh_task is availability_task
    assert main._ev_refresh_task is ev_task
    assert availability_task is not None and ev_task is not None

    assert await asyncio.wait_for(availability_task, timeout=ASYNC_TEST_TIMEOUT) is True
    assert await asyncio.wait_for(ev_task, timeout=ASYNC_TEST_TIMEOUT) is True
    await asyncio.sleep(0)

    assert main.prime_live_feed_caches(trigger="test", client=client) == {
        "availability": "hit",
        "ev": "hit",
    }
    assert main._avail_refresh_task is None
    assert main._ev_refresh_task is None


@pytest.mark.asyncio
async def test_health_schedules_cache_readiness_without_changing_payload(monkeypatch):
    prime = Mock()
    monkeypatch.setattr(main, "prime_live_feed_caches", prime)
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())

    assert await main.health() == {"status": "ok", "carparks_loaded": 3}
    prime.assert_called_once_with(trigger="health")


@pytest.mark.asyncio
async def test_carparks_fetches_feeds_concurrently_and_exposes_timing(monkeypatch):
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    both_started = asyncio.Event()
    started = set()
    fresh_until = time.time() + 30

    async def fake_feed(name, timing, result):
        started.add(name)
        if len(started) == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=ASYNC_TEST_TIMEOUT)
        timing.state = "stale"
        timing.refresh = "background-scheduled"
        timing.duration_ms = 0.4
        timing.fresh_until = fresh_until
        return result

    async def fake_availability(*, timing, **_kwargs):
        return await fake_feed("availability", timing, {})

    async def fake_ev(*, timing, **_kwargs):
        return await fake_feed("ev", timing, {})

    monkeypatch.setattr(main, "get_availability", fake_availability)
    monkeypatch.setattr(main, "get_ev_availability", fake_ev)
    response = main.Response()

    results = await asyncio.wait_for(
        main.get_carparks(
            response=response,
            lat=1.3,
            lon=103.8,
            radius=500,
            category=None,
            free_sun_ph=False,
            has_lots=False,
            has_ev=False,
            has_carwash=False,
        ),
        timeout=ASYNC_TEST_TIMEOUT,
    )

    assert len(results) == 2
    assert started == {"availability", "ev"}
    server_timing = response.headers["server-timing"]
    assert (
        "process_uptime;dur=" in server_timing
        and f'desc="{main.PROCESS_BOOT_ID}@{main.PROCESS_BOOTED_AT}"' in server_timing
    )
    assert 'availability;dur=0.4;desc="stale:background-scheduled"' in server_timing
    assert 'ev;dur=0.4;desc="stale:background-scheduled"' in server_timing
    assert "local_filter;dur=" in server_timing
    assert "total;dur=" in server_timing
    assert response.headers["timing-allow-origin"] == "*"
    assert response.headers["x-ehparkleh-availability-state"] == "stale"
    assert response.headers["x-ehparkleh-ev-state"] == "stale"
    expected_fresh_until = datetime.fromtimestamp(fresh_until, timezone.utc).isoformat()
    assert response.headers["x-ehparkleh-availability-fresh-until"] == expected_fresh_until
    assert response.headers["x-ehparkleh-ev-fresh-until"] == expected_fresh_until
    assert datetime.fromisoformat(response.headers["x-ehparkleh-generated-at"]).tzinfo
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_osm_identifies_the_app_to_overpass(monkeypatch):
    request = {}

    class _OsmResponse:
        def json(self):
            return {
                "elements": [
                    {
                        "type": "node",
                        "id": 42,
                        "lat": 1.3324,
                        "lon": 103.8475,
                        "tags": {"amenity": "parking", "name": "Test parking"},
                    }
                ]
            }

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            request.update(url=url, **kwargs)
            return _OsmResponse()

    monkeypatch.setattr(main, "_osm_cache", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())

    results = await main.parking_osm(lat=1.3323, lon=103.8474, radius=500)

    assert request["url"] == "https://overpass-api.de/api/interpreter"
    assert request["headers"] == {"User-Agent": main.OVERPASS_USER_AGENT}
    assert results[0].id == "osm_42"
    assert results[0].name == "Test parking"


@pytest.mark.asyncio
async def test_lifespan_reuses_and_closes_one_upstream_client(monkeypatch):
    class _SharedClient:
        def __init__(self, **_kwargs):
            self.closed = False

        async def aclose(self):
            self.closed = True

    shared = _SharedClient()
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: shared)
    monkeypatch.setattr(main, "load_carpark_records", _build_cache)

    async with main.lifespan(main.app):
        assert main._upstream_client is shared
        assert not shared.closed

    assert shared.closed
    assert main._upstream_client is None

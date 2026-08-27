"""Backend hardening tests: data, filtering, and live-feed cache behavior."""

import asyncio
import json
import math
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
import restricted  # noqa: E402

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


def test_has_lots_passes_uncounted_carparks_and_drops_known_zero(monkeypatch):
    """The live feed covers HDB/LTA carparks only: 1,581 of 3,566 served records
    -- every URA street carpark among them -- can never appear in it. Uncounted
    is not full (13 of the 14 dropped at Jurong East MRT had unknown counts, not
    zeros), so unknown passes the filter; a known 0 still goes."""
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    availability = {
        "A": {"lots_available": 10, "total_lots": 100},
        "B": {"lots_available": 0, "total_lots": 50},
        # C has no feed entry at all: uncounted.
    }
    out = main.filter_carparks(
        1.3000, 103.8000, radius=20000, availability=availability, has_lots=True
    )
    assert {c.id for c in out} == {"A", "C"}
    c = next(c for c in out if c.id == "C")
    assert c.lots_available is None


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
async def test_suggestions_propagates_onemap_http_failure(monkeypatch):
    class _SuggestionResponse:
        def raise_for_status(self):
            request = main.httpx.Request("GET", "https://www.onemap.gov.sg")
            response = main.httpx.Response(503, request=request)
            raise main.httpx.HTTPStatusError("upstream failure", request=request, response=response)

        def json(self):
            return {"results": []}

    class _SuggestionClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return _SuggestionResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _SuggestionClient())

    with pytest.raises(main.HTTPException) as error:
        await main.suggestions(q="Toa Payoh")

    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_suggestions_propagates_onemap_timeout(monkeypatch):
    class _SuggestionClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            raise main.httpx.ReadTimeout("upstream timeout")

    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _SuggestionClient())

    with pytest.raises(main.HTTPException) as error:
        await main.suggestions(q="Toa Payoh")

    assert error.value.status_code == 504


@pytest.mark.asyncio
async def test_suggestions_keeps_valid_no_match_empty(monkeypatch):
    class _SuggestionResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"results": []}

    class _SuggestionClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return _SuggestionResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _SuggestionClient())

    assert await main.suggestions(q="Not a real address") == []


@pytest.mark.asyncio
async def test_suggestions_rejects_wholly_malformed_matches(monkeypatch):
    class _SuggestionResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "results": [
                    {"ADDRESS": "Missing coordinates"},
                    {"ADDRESS": "Invalid coordinates", "LATITUDE": "north", "LONGITUDE": "east"},
                ]
            }

    class _SuggestionClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return _SuggestionResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _SuggestionClient())

    with pytest.raises(main.HTTPException) as error:
        await main.suggestions(q="Toa Payoh")

    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_suggestions_skips_isolated_malformed_matches(monkeypatch):
    class _SuggestionResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "results": [
                    {"ADDRESS": "Missing coordinates"},
                    {"ADDRESS": "Toa Payoh Hub", "LATITUDE": "1.33", "LONGITUDE": "103.85"},
                ]
            }

    class _SuggestionClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return _SuggestionResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _SuggestionClient())

    assert await main.suggestions(q="Toa Payoh") == [
        main.Suggestion(address="Toa Payoh Hub", lat=1.33, lon=103.85)
    ]


def _mock_onemap_payload(monkeypatch, payload):
    class _OneMapResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return payload

    class _OneMapClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return _OneMapResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OneMapClient())


@pytest.mark.asyncio
async def test_geocode_keeps_valid_no_match_not_found(monkeypatch):
    _mock_onemap_payload(monkeypatch, {"results": []})

    with pytest.raises(main.HTTPException) as error:
        await main.geocode(q="Not a real address")

    assert error.value.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"results": None},
        {"results": {"ADDRESS": "Not a list"}},
        ["Not an object"],
    ],
)
async def test_geocode_rejects_malformed_results_shape(monkeypatch, payload):
    _mock_onemap_payload(monkeypatch, payload)

    with pytest.raises(main.HTTPException) as error:
        await main.geocode(q="Toa Payoh")

    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_geocode_rejects_wholly_malformed_matches(monkeypatch):
    _mock_onemap_payload(
        monkeypatch,
        {
            "results": [
                {"ADDRESS": "Missing coordinates"},
                {"ADDRESS": "Invalid coordinates", "LATITUDE": "north", "LONGITUDE": "east"},
            ]
        },
    )

    with pytest.raises(main.HTTPException) as error:
        await main.geocode(q="Toa Payoh")

    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_geocode_skips_isolated_malformed_matches(monkeypatch):
    _mock_onemap_payload(
        monkeypatch,
        {
            "results": [
                {"ADDRESS": "Missing coordinates"},
                {"ADDRESS": "Toa Payoh Hub", "LATITUDE": "1.33", "LONGITUDE": "103.85"},
            ]
        },
    )

    assert await main.geocode(q="Toa Payoh") == main.GeocodeResult(
        address="Toa Payoh Hub", lat=1.33, lon=103.85
    )


def _snapshot_feature(osm_id, lat, lon, name=None, fee=None, parking_type=None):
    """One record in enrich/osm_parking.json's shape, as crawl_osm.py writes it."""
    return {
        "osm_id": osm_id,
        "name": name,
        "lat": lat,
        "lon": lon,
        "access": None,
        "fee": fee,
        "parking_type": parking_type,
    }


def _install_shipped_snapshot(monkeypatch, features):
    """Stand a synthetic crawl in for the shipped one, already loaded."""
    monkeypatch.setattr(
        main,
        "_osm_snapshot",
        [
            element
            for element in (main._snapshot_element(f) for f in features)
            if element is not None
        ],
    )
    monkeypatch.setattr(main, "_osm_snapshot_loaded", True)


def _disable_shipped_snapshot(monkeypatch):
    """Simulate the snapshot file being missing or unreadable."""
    monkeypatch.setattr(main, "_osm_snapshot", None)
    monkeypatch.setattr(main, "_osm_snapshot_loaded", True)


@pytest.mark.asyncio
async def test_osm_identifies_the_app_to_overpass(monkeypatch):
    request = {}

    class _OsmResponse:
        def raise_for_status(self):
            return None

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
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())

    response = main.Response()
    results = await main.parking_osm(response=response, lat=1.3323, lon=103.8474, radius=500)

    assert request["url"] == "https://overpass-api.de/api/interpreter"
    assert request["headers"] == {"User-Agent": main.OVERPASS_USER_AGENT}
    assert results[0].id == "osm_42"
    assert results[0].name == "Test parking"
    assert response.headers["x-ehparkleh-osm-state"] == "fresh"


@pytest.mark.asyncio
async def test_osm_502s_only_when_nothing_at_all_can_be_served(monkeypatch):
    """The last-resort path: Overpass down, both caches cold AND the shipped
    snapshot unusable. Only then may the overlay fail, because only then is
    there genuinely nothing to show."""

    class _OsmResponse:
        def raise_for_status(self):
            request = main.httpx.Request("POST", "https://overpass-api.de")
            response = main.httpx.Response(503, request=request)
            raise main.httpx.HTTPStatusError("upstream failure", request=request, response=response)

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return _OsmResponse()

    monkeypatch.setattr(main, "_osm_cache", {})
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())
    _disable_shipped_snapshot(monkeypatch)

    with pytest.raises(main.HTTPException) as error:
        await main.parking_osm(response=main.Response(), lat=1.3323, lon=103.8474, radius=500)

    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_osm_rejects_overpass_error_remark(monkeypatch):
    class _OsmResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"remark": "runtime error", "elements": []}

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return _OsmResponse()

    osm_cache = {}
    monkeypatch.setattr(main, "_osm_cache", osm_cache)
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())
    # The point here is that a remark payload is never cached as if it were
    # data; the snapshot floor is stood down so the failure stays observable.
    _disable_shipped_snapshot(monkeypatch)

    with pytest.raises(main.HTTPException) as error:
        await main.parking_osm(response=main.Response(), lat=1.3323, lon=103.8474, radius=500)

    assert error.value.status_code == 502
    assert osm_cache == {}


@pytest.mark.asyncio
async def test_osm_marks_cached_fallback_stale(monkeypatch):
    class _OsmResponse:
        def raise_for_status(self):
            request = main.httpx.Request("POST", "https://overpass-api.de")
            response = main.httpx.Response(503, request=request)
            raise main.httpx.HTTPStatusError("upstream failure", request=request, response=response)

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return _OsmResponse()

    cached_element = {
        "id": "osm_cached",
        "name": "Cached parking",
        "lat": 1.3324,
        "lon": 103.8475,
        "fee": None,
        "parking_type": None,
        "capacity": None,
    }
    key = (round(1.3323, 3), round(103.8474, 3), 500)
    monkeypatch.setattr(
        main,
        "_osm_cache",
        {key: (time.monotonic() - main.OSM_TTL_SECONDS - 1, [cached_element])},
    )
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())

    response = main.Response()
    results = await main.parking_osm(response=response, lat=1.3323, lon=103.8474, radius=500)

    # The stale fallback serves the same cached elements as a hit would — and
    # like a hit, it measures distance from the requesting point.
    assert results == [
        main.OsmParking(
            id="osm_cached",
            name="Cached parking",
            lat=1.3324,
            lon=103.8475,
            distance_m=round(main.haversine(1.3323, 103.8474, 1.3324, 103.8475)),
        )
    ]
    assert response.headers["x-ehparkleh-osm-state"] == "stale"


def _rate_limited_response(url: str, retry_after: str | None = None):
    """A mock Overpass response whose raise_for_status raises a real 429."""

    class _Response:
        def raise_for_status(self):
            request = main.httpx.Request("POST", url)
            headers = {"retry-after": retry_after} if retry_after else {}
            response = main.httpx.Response(429, request=request, headers=headers)
            raise main.httpx.HTTPStatusError(
                "rate limited", request=request, response=response
            )

    return _Response()


def _elements_response(elements):
    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"elements": elements}

    return _Response()


@pytest.mark.asyncio
async def test_osm_falls_back_to_next_endpoint_when_primary_rate_limits(monkeypatch):
    """The deployed failure mode: overpass-api.de instantly rejects the shared
    egress IP (429 fair-use). A mirror answering must yield a normal fresh 200,
    never a user-visible 502 — and the rejected endpoint must enter cooldown."""
    calls = []

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **_kwargs):
            calls.append(url)
            if url == main.OVERPASS_ENDPOINTS[0]:
                return _rate_limited_response(url)
            return _elements_response(
                [
                    {
                        "type": "node",
                        "id": 77,
                        "lat": 1.3324,
                        "lon": 103.8475,
                        "tags": {"amenity": "parking", "name": "Mirror parking"},
                    }
                ]
            )

    monkeypatch.setattr(main, "_osm_cache", {})
    cooldown: dict = {}
    monkeypatch.setattr(main, "_overpass_cooldown", cooldown)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())

    response = main.Response()
    results = await main.parking_osm(response=response, lat=1.3323, lon=103.8474, radius=500)

    assert calls == [main.OVERPASS_ENDPOINTS[0], main.OVERPASS_ENDPOINTS[1]]
    assert results[0].id == "osm_77"
    assert results[0].name == "Mirror parking"
    assert response.headers["x-ehparkleh-osm-state"] == "fresh"
    # Only the rejected endpoint is cooling down; the mirror that answered is not.
    assert main.OVERPASS_ENDPOINTS[0] in cooldown
    assert main.OVERPASS_ENDPOINTS[1] not in cooldown


@pytest.mark.asyncio
async def test_osm_skips_endpoint_during_cooldown_and_honours_retry_after(monkeypatch):
    """Fair use: an endpoint that answered 429 is not re-hit on the next search
    while its cooldown (Retry-After when given) lasts."""
    calls = []

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **_kwargs):
            calls.append(url)
            if url == main.OVERPASS_ENDPOINTS[0]:
                return _rate_limited_response(url, retry_after="120")
            return _elements_response([])

    monkeypatch.setattr(main, "_osm_cache", {})
    cooldown: dict = {}
    monkeypatch.setattr(main, "_overpass_cooldown", cooldown)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())

    await main.parking_osm(response=main.Response(), lat=1.3323, lon=103.8474, radius=500)
    assert calls == [main.OVERPASS_ENDPOINTS[0], main.OVERPASS_ENDPOINTS[1]]
    # Retry-After: 120 is honoured, not the 60s default.
    assert cooldown[main.OVERPASS_ENDPOINTS[0]] - time.monotonic() > 100

    # A search in a different cache cell goes straight to the mirror.
    calls.clear()
    await main.parking_osm(response=main.Response(), lat=1.34, lon=103.86, radius=500)
    assert calls == [main.OVERPASS_ENDPOINTS[1]]


@pytest.mark.asyncio
async def test_osm_serves_wider_cached_snapshot_when_every_endpoint_fails(monkeypatch):
    """With all mirrors down and no exact-key entry, a cached wider fetch that
    covers the requested disc is served (filtered to the requested radius)
    instead of a 502 — the strip only appears when there is truly nothing."""

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **_kwargs):
            return _rate_limited_response(url)

    near = {
        "id": "osm_near",
        "name": "Near parking",
        "lat": 1.3330,
        "lon": 103.8480,
        "fee": None,
        "parking_type": None,
        "capacity": None,
    }
    far = {
        "id": "osm_far",
        "name": "Far parking",
        "lat": 1.3460,  # ~1.5 km north: inside the cached 2000 m fetch,
        "lon": 103.8474,  # outside the requested 500 m radius
        "fee": None,
        "parking_type": None,
        "capacity": None,
    }
    wide_key = (round(1.3323, 3), round(103.8474, 3), 2000)
    monkeypatch.setattr(
        main,
        "_osm_cache",
        {wide_key: (time.monotonic() - main.OSM_TTL_SECONDS - 1, [near, far])},
    )
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())

    response = main.Response()
    results = await main.parking_osm(response=response, lat=1.3323, lon=103.8474, radius=500)

    assert [r.id for r in results] == ["osm_near"]
    assert response.headers["x-ehparkleh-osm-state"] == "stale"


@pytest.mark.asyncio
async def test_osm_cached_snapshot_too_far_away_is_not_served(monkeypatch):
    """A cached fetch that does not cover the requested disc must not be passed
    off as an answer for it. It is skipped in favour of the shipped snapshot,
    which does describe the requested area."""

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **_kwargs):
            return _rate_limited_response(url)

    # A 500 m fetch ~5 km away says nothing about the requested area.
    far_element = _snapshot_feature("node/999001", 1.3770, 103.8474, name="Five km away")
    far_key = (round(1.3770, 3), round(103.8474, 3), 500)
    monkeypatch.setattr(
        main,
        "_osm_cache",
        {far_key: (time.monotonic(), [main._snapshot_element(far_element)])},
    )
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())
    _install_shipped_snapshot(
        monkeypatch, [_snapshot_feature("node/999002", 1.3324, 103.8475, name="In range")]
    )

    response = main.Response()
    results = await main.parking_osm(
        response=response, lat=1.3323, lon=103.8474, radius=500
    )

    assert [r.id for r in results] == ["osm_999002"]
    assert response.headers["x-ehparkleh-osm-state"] == "snapshot"


@pytest.mark.asyncio
async def test_osm_cache_hit_remeasures_distance_for_each_requester(monkeypatch):
    """Regression: the cache key rounds coordinates to ~110 m cells, so two
    searches in one cell share the upstream fetch. The served `distance_m`
    values must still be measured from each caller's own coordinates, not
    reused from whoever warmed the cell."""

    class _OsmResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "elements": [
                    {
                        "type": "node",
                        "id": 7,
                        "lat": 1.33240,
                        "lon": 103.84750,
                        "tags": {"amenity": "parking", "name": "Cell parking"},
                    }
                ]
            }

    class _OsmClient:
        def __init__(self):
            self.calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            self.calls += 1
            return _OsmResponse()

    client = _OsmClient()

    # Two requesters ~5-6 m apart: the same rounded cache cell, different
    # exact coordinates.
    first_lat, first_lon = 1.33230, 103.84740
    second_lat, second_lon = 1.33235, 103.84745
    assert (round(first_lat, 3), round(first_lon, 3)) == (
        round(second_lat, 3),
        round(second_lon, 3),
    )

    monkeypatch.setattr(main, "_osm_cache", {})
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: client)

    fresh_response = main.Response()
    fresh = await main.parking_osm(
        response=fresh_response, lat=first_lat, lon=first_lon, radius=500
    )
    assert fresh_response.headers["x-ehparkleh-osm-state"] == "fresh"
    assert fresh[0].distance_m == round(main.haversine(first_lat, first_lon, 1.33240, 103.84750))

    hit_response = main.Response()
    hit = await main.parking_osm(
        response=hit_response, lat=second_lat, lon=second_lon, radius=500
    )

    # One shared upstream fetch, but per-request distances.
    assert client.calls == 1
    assert hit_response.headers["x-ehparkleh-osm-state"] == "hit"
    assert hit[0].distance_m == round(main.haversine(second_lat, second_lon, 1.33240, 103.84750))
    assert hit[0].distance_m != fresh[0].distance_m


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


# ---------------------------------------------------------------------------
# Restricted areas (army camps, air/naval bases, prisons)
# ---------------------------------------------------------------------------
ENRICH_DIR = BACKEND_DIR / "enrich"

# The reported bug: /api/parking/osm served two carparks inside Kranji Camp
# alongside three legitimate public HDB carparks 400-500m away. These are the
# exact five elements Overpass returns for a 500m search at the camp's address
# (151 Choa Chu Kang Way S688248).
KRANJI_RESTRICTED = [
    ("way/453708943", "CMTL", 1.4047335, 103.7406529),
    ("way/453708951", "Blk 922", 1.4014807, 103.742777),
]
KRANJI_PUBLIC = [
    ("way/238927560", "Choa Chu Kang Street 62", 1.4004480, 103.7437120),
    ("way/238927634", "Blk 678A", 1.4019110, 103.7448730),
    ("way/238927639", "Choa Chu Kang Crescent", 1.4043040, 103.7458380),
]


def _kranji_overpass_elements():
    return [
        {
            "type": "way",
            "id": int(osm_id.split("/")[1]),
            "center": {"lat": lat, "lon": lon},
            "tags": {"amenity": "parking", "name": name},
        }
        for osm_id, name, lat, lon in KRANJI_RESTRICTED + KRANJI_PUBLIC
    ]


def _stub_overpass(monkeypatch, elements):
    class _OsmResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"elements": elements}

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return _OsmResponse()

    monkeypatch.setattr(main, "_osm_cache", {})
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())


@pytest.mark.asyncio
async def test_osm_drops_carparks_inside_kranji_camp(monkeypatch):
    """The reported case: camp carparks out, the public ones next door in."""
    _stub_overpass(monkeypatch, _kranji_overpass_elements())

    results = await main.parking_osm(
        response=main.Response(), lat=1.4041301, lon=103.7416159, radius=500
    )

    served = {r.id for r in results}
    for osm_id, name, _lat, _lon in KRANJI_RESTRICTED:
        assert f"osm_{osm_id.split('/')[1]}" not in served, f"{name} is inside Kranji Camp"
    for osm_id, name, _lat, _lon in KRANJI_PUBLIC:
        assert f"osm_{osm_id.split('/')[1]}" in served, f"{name} is a public HDB carpark"
    assert len(results) == len(KRANJI_PUBLIC)


@pytest.mark.asyncio
async def test_osm_refuses_to_serve_without_restricted_polygons(monkeypatch):
    """A missing polygon set must fail, never quietly serve everything."""
    _stub_overpass(monkeypatch, _kranji_overpass_elements())
    monkeypatch.setattr(main, "_restricted_areas", None)
    monkeypatch.setattr(
        main,
        "load_restricted_areas",
        Mock(side_effect=main.RestrictedDataError("military_areas.json is missing")),
    )

    with pytest.raises(main.HTTPException) as error:
        await main.parking_osm(
            response=main.Response(), lat=1.4041301, lon=103.7416159, radius=500
        )

    assert error.value.status_code == 503


def test_restricted_areas_excludes_the_reported_kranji_carparks():
    areas = restricted.load_restricted_areas()

    for osm_id, name, lat, lon in KRANJI_RESTRICTED:
        assert areas.contains(lat, lon), f"{osm_id} {name} should be restricted"
    for osm_id, name, lat, lon in KRANJI_PUBLIC:
        assert not areas.contains(lat, lon), f"{osm_id} {name} should be usable"
    # The camp's own registered address, which Google reverse-geocoded the
    # mis-served pins to.
    assert areas.contains(1.4041301, 103.7416159)


@pytest.mark.parametrize(
    "filename,floor",
    [
        ("military_areas.json", restricted.MIN_MILITARY_RINGS),
        ("restricted_areas.json", restricted.MIN_SPECIAL_USE_RINGS),
    ],
)
def test_shipped_polygon_rings_are_closed(filename, floor):
    """72 of the old file's 199 rings were open relation fragments: an open ring
    is implicitly closed by the containment test, covering the wrong area."""
    rings = json.loads((ENRICH_DIR / filename).read_text())

    assert len(rings) >= floor
    open_rings = [i for i, ring in enumerate(rings) if ring[0] != ring[-1]]
    assert not open_rings, f"{filename}: rings {open_rings[:5]} are not closed"
    assert all(len(ring) >= 4 for ring in rings)


def test_restricted_load_rejects_a_truncated_polygon_set(tmp_path):
    """Fail closed: a short file must raise, not filter almost nothing."""
    truncated = tmp_path / "military_areas.json"
    square = [[1.0, 103.0], [1.0, 103.1], [1.1, 103.1], [1.1, 103.0], [1.0, 103.0]]
    truncated.write_text(json.dumps([square]))

    with pytest.raises(restricted.RestrictedDataError):
        restricted._load_rings(str(truncated), restricted.MIN_MILITARY_RINGS)

    with pytest.raises(restricted.RestrictedDataError):
        restricted._load_rings(str(tmp_path / "absent.json"), 1)


def test_restricted_areas_catch_the_osm_parking_corpus():
    """The live layer queries this same amenity=parking corpus, so every
    restricted entry in it is an entry a search near that site could serve."""
    areas = restricted.load_restricted_areas()
    corpus = json.loads((ENRICH_DIR / "osm_parking.json").read_text())

    caught = [o for o in corpus if areas.contains(o["lat"], o["lon"])]
    assert len(caught) >= 65, f"only {len(caught)} restricted entries caught"


def test_restricted_areas_keep_every_public_hdb_carpark():
    """No false positives against HDB's own authoritative public-carpark list.

    Uses gov_hdb.json rather than the served dataset because carparks_enriched.json
    is built at deploy time and is not in the repo. carparks_geocoded.json is not a
    substitute: ten of its SVY21-fallback coordinates land inside a camp and are
    only corrected by the OneMap re-geocode the build runs before this filter.
    """
    areas = restricted.load_restricted_areas()
    hdb = json.loads((ENRICH_DIR / "gov_hdb.json").read_text())

    excluded = [c["id"] for c in hdb if areas.contains(c["lat"], c["lon"])]
    assert not excluded, f"restricted filter would drop public HDB carparks: {excluded[:5]}"


def test_restricted_areas_keep_every_served_carpark():
    """Same check against the real served dataset, when it has been built."""
    enriched = BACKEND_DIR / "carparks_enriched.json"
    if not enriched.exists():
        pytest.skip("carparks_enriched.json is built at deploy time")

    areas = restricted.load_restricted_areas()
    served = json.loads(enriched.read_text())

    excluded = [cp["id"] for cp in served if areas.contains(cp["lat"], cp["lon"])]
    assert not excluded, f"restricted filter would drop served carparks: {excluded[:5]}"


# The static-dataset half of the same rule. /api/carparks never applied the
# restricted filter itself: it trusted enrich/build_enriched.py to have voided
# camp rows already, and _data_file() silently falls back to the *unfiltered*
# carparks_geocoded.json when the enriched artifact is absent (build.sh not run
# on the deploy). On that path ten SVY21-fallback HDB coordinates sit inside a
# camp -- CK39/CK55/CK65 are in the Keat Hong / Choa Chu Kang camp land the
# reported carpark belongs to -- and each came with a working Waze deep link.
GEOCODED_RESTRICTED_IDS = {"A12", "BJ65", "CK39", "CK55", "CK65", "JS33", "Y23", "Y34", "Y7", "Y8"}


def test_load_carpark_records_filters_the_unfiltered_geocoded_fallback(monkeypatch):
    """The served cache must be filtered whichever dataset file backs it."""
    geocoded = BACKEND_DIR / "carparks_geocoded.json"
    monkeypatch.setattr(main, "_data_file", lambda: geocoded)

    served = {cp["id"] for cp in main.load_carpark_records()}

    assert not (served & GEOCODED_RESTRICTED_IDS), (
        f"restricted carparks served from the fallback dataset: "
        f"{sorted(served & GEOCODED_RESTRICTED_IDS)}"
    )
    # It filters, rather than refusing to load anything.
    assert len(served) > 2000


def test_no_served_carpark_is_inside_restricted_land():
    """End-to-end over whichever dataset this deploy actually serves."""
    areas = restricted.load_restricted_areas()

    served = main.load_carpark_records()

    offered = [cp["id"] for cp in served if areas.contains(cp["lat"], cp["lon"])]
    assert not offered, f"restricted carparks offered by /api/carparks: {offered[:5]}"


def test_load_carpark_records_fails_closed_without_polygons(monkeypatch):
    """Fail-closed contract: no polygons means no dataset, never an unfiltered one."""
    monkeypatch.setattr(main, "_restricted_areas", None)
    monkeypatch.setattr(
        main,
        "load_restricted_areas",
        Mock(side_effect=main.RestrictedDataError("military_areas.json is missing")),
    )

    with pytest.raises(main.RestrictedDataError):
        main.load_carpark_records()


# ---------------------------------------------------------------------------
# Bug-sweep regressions: EV attribution + free-parking seed (build pipeline)
# ---------------------------------------------------------------------------
def _ev_carpark(cid, lat, lon):
    return {"id": cid, "name": cid, "address": cid, "lat": lat, "lon": lon,
            "sources": ["hdb"]}


def _ev_site(lat, lon, *cp_ids):
    return {"lat": lat, "lon": lon,
            "connectors": [{"evCpId": cid, "operator": "OP", "powerRating": "50"}
                           for cid in cp_ids]}


def test_ev_site_is_attributed_to_its_nearest_carpark_only():
    """One charger site must speak for exactly one carpark. Flagging every
    served record within 75m let 241 LTA sites be claimed by 2+ carparks
    (366 cards showing connectors that belonged next door)."""
    import build_enriched as be

    m_lat = 1.0 / 111_195.0          # ~1 metre of latitude in degrees
    lat, lon = 1.305784, 103.856793  # the report's Kelantan Lane charger site

    near = _ev_carpark("NEAR", lat + 10 * m_lat, lon)
    mid = _ev_carpark("MID", lat + 45 * m_lat, lon)
    far = _ev_carpark("FAR", lat - 500 * m_lat, lon)

    sites = [
        # Nearest NEAR (10m); MID is also within 75m but loses.
        _ev_site(lat, lon, "EV-K"),
        # 15m south of NEAR: nearest NEAR again, so its connector aggregates.
        _ev_site(near["lat"] - 15 * m_lat, near["lon"], "EV-L"),
        # 5m from MID: MID wins even though NEAR is within radius too.
        _ev_site(mid["lat"] + 5 * m_lat, mid["lon"], "EV-M"),
        # Far outside everyone's radius: claimed by nobody.
        _ev_site(far["lat"] - 100 * m_lat, far["lon"], "EV-X"),
    ]

    flagged = be.attribute_ev_chargers([near, mid, far], sites)

    assert flagged == 2
    assert near["ev_cp_ids"] == ["EV-K", "EV-L"]
    assert near["ev_total"] == 2
    assert near["ev_operators"] == ["OP"]
    assert near["ev_max_power_kw"] == 50.0
    assert mid["ev_cp_ids"] == ["EV-M"]
    assert "ev" not in far


def test_ev_site_equidistant_claims_the_lower_id():
    """Ties break on id so a rebuild attributes the same site the same way."""
    import build_enriched as be

    lat = 1.305784
    lon = 103.856793
    m_lon = 1.0 / (111_320.0 * math.cos(math.radians(lat)))
    a = _ev_carpark("AAA", lat, lon - 30 * m_lon)
    b = _ev_carpark("BBB", lat, lon + 30 * m_lon)
    site = _ev_site(lat, lon, "EV-T")

    assert abs(be.haversine(a["lat"], a["lon"], site["lat"], site["lon"])
               - be.haversine(b["lat"], b["lon"], site["lat"], site["lon"])) < 1e-9

    be.attribute_ev_chargers([b, a], [site])

    assert a.get("ev_cp_ids") == ["EV-T"]
    assert "ev" not in b


def _stage_minimal_build(tmp_path, monkeypatch):
    """Stage an offline build_enriched.main() run: geocoded spine + HDB feed +
    two EV sites; every optional layer absent."""
    import build_enriched as be

    m_lat = 1.0 / 111_195.0
    base_lat, base_lon = 1.3541, 103.8745

    geocoded = [
        {"id": "CPHDB", "address": "BLK 180 TEST AVENUE 1", "lat": base_lat,
         "lon": base_lon, "source": "onemap", "type": "MULTI-STOREY",
         "free_parking": "NO"},  # stale geocoded copy of the truth below
        {"id": "CPLTA", "address": "LTA ONLY CP", "lat": base_lat + 40 * m_lat,
         "lon": base_lon, "source": "onemap", "type": None, "free_parking": None},
    ]
    gov_hdb = [{
        "id": "CPHDB", "car_park_type": "MULTI-STOREY CAR PARK",
        "short_term_parking": "WHOLE DAY", "night_parking": "NO",
        "free_parking": "SUN & PH FR 7AM-10.30PM", "car_park_decks": "4",
        "gantry_height": "2.20", "car_park_basement": "N",
        "lat": base_lat, "lon": base_lon,
    }]
    ev_points = [
        # 15m north of CPHDB, 25m south of CPLTA: CPHDB is nearest, and CPLTA
        # stays inside the old 75m everyone-claims radius.
        _ev_site(base_lat + 15 * m_lat, base_lon, "EV-NEAR"),
        _ev_site(base_lat - 300 * m_lat, base_lon, "EV-FAR"),
    ]

    geocoded_path = tmp_path / "geocoded.json"
    hdb_path = tmp_path / "gov_hdb.json"
    ev_path = tmp_path / "ev_points.json"
    geocoded_path.write_text(json.dumps(geocoded))
    hdb_path.write_text(json.dumps(gov_hdb))
    ev_path.write_text(json.dumps(ev_points))

    monkeypatch.setattr(be, "GEOCODED", str(geocoded_path))
    monkeypatch.setattr(be, "GOV_HDB", str(hdb_path))
    monkeypatch.setattr(be, "EV", str(ev_path))
    for name in ("GOOGLE", "OSM", "GOV_URA", "GOV_RATES", "MANUAL_VOIDS",
                 "CENTRAL_AREA", "SG_BOUNDARY", "ONEMOTORING", "MANUAL_RATES",
                 "CARWASH_LOCATIONS"):
        monkeypatch.setattr(be, name, str(tmp_path / "absent.json"))
    monkeypatch.setattr(be, "OUT", str(tmp_path / "out.json"))
    monkeypatch.setattr(be, "STATS", str(tmp_path / "stats.md"))
    monkeypatch.setattr(be, "ONEMAP_CACHE", str(tmp_path / "onemap_cache.json"))
    return be


def test_build_seeds_free_parking_from_the_hdb_feed(tmp_path, monkeypatch):
    """The spine's top-level free_parking must come from the authoritative HDB
    crawl, not the stale geocoded copy: all 14 mismatches were served NO while
    HDB said free, hiding them from the Free Sun & PH filter."""
    be = _stage_minimal_build(tmp_path, monkeypatch)
    be.main()

    out = {r["id"]: r for r in json.loads(Path(be.OUT).read_text())}

    assert out["CPHDB"]["free_parking"] == "SUN & PH FR 7AM-10.30PM"
    assert out["CPHDB"]["free_parking"] == out["CPHDB"]["hdb_info"]["free_parking"]
    # No HDB record: falls back to the geocoded value rather than losing it.
    assert out["CPLTA"]["free_parking"] is None


def test_build_attributes_ev_sites_nearest_only_end_to_end(tmp_path, monkeypatch):
    """Same pipeline run: the site within 75m of BOTH carparks must flag only
    its nearest one."""
    be = _stage_minimal_build(tmp_path, monkeypatch)
    be.main()

    out = {r["id"]: r for r in json.loads(Path(be.OUT).read_text())}

    assert out["CPHDB"].get("ev") is True
    assert out["CPHDB"]["ev_cp_ids"] == ["EV-NEAR"]
    assert "EV-FAR" not in out["CPHDB"]["ev_cp_ids"]
    assert "ev" not in out["CPLTA"]  # within the old 75m claim radius, nobody's nearest


# ---------------------------------------------------------------------------
# Bug-sweep regression: live OSM layer must not re-pin merged carparks
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_osm_suppresses_live_pins_that_merge_with_served_carparks(monkeypatch):
    """206 live pins sat 60-90m from their nearest served card -- duplicates by
    the build's own merge rule that the browser's 60m net cannot catch. The
    server drops them before they ever reach the map."""
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    served_lat, served_lon = 1.3000, 103.8000
    m_lat = 1.0 / 111_195.0
    m_lon = 1.0 / (111_320.0 * math.cos(math.radians(served_lat)))

    dup_in_band = {   # 75m north: inside the build's 90m merge radius
        "type": "node", "id": 101, "lat": served_lat + 75 * m_lat, "lon": served_lon,
        "tags": {"amenity": "parking", "name": "Same carpark, re-pinned"},
    }
    close_dup = {     # 30m west: also inside it
        "type": "node", "id": 102, "lat": served_lat, "lon": served_lon - 30 * m_lon,
        "tags": {"amenity": "parking", "name": "Too close"},
    }
    genuinely_far = {  # 400m east: outside any merge radius, must survive
        "type": "node", "id": 103, "lat": served_lat, "lon": served_lon + 400 * m_lon,
        "tags": {"amenity": "parking", "name": "A different carpark"},
    }

    band_d = main.haversine(dup_in_band["lat"], dup_in_band["lon"], served_lat, served_lon)
    far_d = main.haversine(genuinely_far["lat"], genuinely_far["lon"], served_lat, served_lon)
    # 75m sits in the old leak band: past the browser's 60m net, inside the build's merge radius.
    assert main.OSM_DEDUP_M - 30 < band_d <= main.OSM_DEDUP_M
    assert band_d > 60.0
    assert far_d > main.OSM_DEDUP_M

    _stub_overpass(monkeypatch, [dup_in_band, close_dup, genuinely_far])
    results = await main.parking_osm(
        response=main.Response(), lat=served_lat, lon=served_lon, radius=500
    )

    assert [r.id for r in results] == ["osm_103"]
    assert results[0].name == "A different carpark"


def test_osm_suppresses_nothing_when_dataset_not_loaded(monkeypatch):
    """Startup window: an empty cache suppresses nothing rather than every pin."""
    monkeypatch.setattr(main, "_carpark_cache", [])
    assert main.merges_with_served(1.30, 103.80) is False


def test_osm_dedup_radius_is_the_build_merge_rule_itself():
    """main.py imports DEDUPE_HARD_M instead of restating it; this pins the
    import against silent drift back to a local literal."""
    import build_enriched as be

    assert main.OSM_DEDUP_M == be.DEDUPE_HARD_M == 90.0


def test_served_near_prefilter_keeps_every_true_neighbour(loaded_cache):
    """The bounding-box prefilter is an optimisation, not a behaviour change:
    for any pin, the narrowed candidate list must reach the same verdict as a
    full scan of the dataset."""
    probes = [
        (1.3000, 103.8000),
        (1.2830, 103.8510),
        (1.4400, 103.7800),
        (1.3521, 103.9200),
    ]
    candidates = main.served_near(probes, main.OSM_DEDUP_M)
    assert len(candidates) < len(loaded_cache)
    for lat, lon in probes:
        assert main.merges_with_served(lat, lon, candidates) == main.merges_with_served(
            lat, lon
        )


# ---------------------------------------------------------------------------
# The shipped-snapshot floor, and the mirror-walk repairs that go with it.
#
# Reproduces the production failure observed on 2026-08-27: /api/parking/osm
# returned 502 on every search from the deployed backend while the identical
# Overpass query answered 200 from a residential IP. Both existing fallback
# tiers read only `_osm_cache`, which nothing but a *successful* Overpass fetch
# ever fills — so during the outage they were empty by construction, and on
# Render's free plan (spun down after ~15 min idle) a cold, empty cache is the
# normal state rather than the exceptional one.
# ---------------------------------------------------------------------------


def _stub_total_overpass_failure(monkeypatch, calls=None):
    """Every endpoint refuses the connection, as Overpass did from Render."""

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **_kwargs):
            if calls is not None:
                calls.append(url)
            raise main.httpx.ConnectError(
                "egress rejected", request=main.httpx.Request("POST", url)
            )

    monkeypatch.setattr(main, "_osm_cache", {})
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())


@pytest.mark.asyncio
async def test_osm_serves_shipped_snapshot_when_overpass_fails_on_a_cold_process(
    monkeypatch,
):
    """The reproduced production failure. A search that used to 502 must now
    answer from the crawl that ships with the build."""
    _stub_total_overpass_failure(monkeypatch)
    _install_shipped_snapshot(
        monkeypatch,
        [
            _snapshot_feature("node/1", 1.3324, 103.8475, name="Snapshot parking"),
            _snapshot_feature("way/2", 1.3330, 103.8480, fee="yes", parking_type="multi-storey"),
        ],
    )

    response = main.Response()
    results = await main.parking_osm(
        response=response, lat=1.3323, lon=103.8474, radius=500
    )

    assert [r.id for r in results] == ["osm_1", "osm_2"]
    assert results[0].name == "Snapshot parking"
    assert results[1].fee == "yes"
    assert results[1].parking_type == "multi-storey"
    # Distances are measured from the requester, exactly as every other tier does.
    assert all(r.distance_m >= 0 for r in results)
    assert response.headers["x-ehparkleh-osm-state"] == "snapshot"


@pytest.mark.asyncio
async def test_snapshot_pin_keeps_the_id_the_live_path_would_have_given_it(monkeypatch):
    """A pin must not change identity when the overlay falls back: the crawl
    stores `way/238927560` where Overpass reports the bare id 238927560, and
    both have to reduce to one id or the same carpark gets two React keys and
    escapes the dedup against the served cards."""
    _stub_overpass(monkeypatch, _kranji_overpass_elements())
    live = await main.parking_osm(
        response=main.Response(), lat=1.4041301, lon=103.7416159, radius=500
    )

    _stub_total_overpass_failure(monkeypatch)
    _install_shipped_snapshot(
        monkeypatch,
        [
            _snapshot_feature(osm_id, lat, lon, name=name)
            for osm_id, name, lat, lon in KRANJI_RESTRICTED + KRANJI_PUBLIC
        ],
    )
    snapshot = await main.parking_osm(
        response=main.Response(), lat=1.4041301, lon=103.7416159, radius=500
    )

    assert {r.id for r in snapshot} == {r.id for r in live}


@pytest.mark.asyncio
async def test_snapshot_excludes_restricted_land(monkeypatch):
    """The snapshot is raw OSM, so it carries the camp carparks the live path
    already drops. Serving it must apply the same exclusion."""
    _stub_total_overpass_failure(monkeypatch)
    _install_shipped_snapshot(
        monkeypatch,
        [
            _snapshot_feature(osm_id, lat, lon, name=name)
            for osm_id, name, lat, lon in KRANJI_RESTRICTED + KRANJI_PUBLIC
        ],
    )

    results = await main.parking_osm(
        response=main.Response(), lat=1.4041301, lon=103.7416159, radius=500
    )

    served = {r.id for r in results}
    for osm_id, name, _lat, _lon in KRANJI_RESTRICTED:
        assert f"osm_{osm_id.split('/')[1]}" not in served, f"{name} is inside Kranji Camp"
    for osm_id, name, _lat, _lon in KRANJI_PUBLIC:
        assert f"osm_{osm_id.split('/')[1]}" in served, f"{name} is a public HDB carpark"


@pytest.mark.asyncio
async def test_snapshot_dedups_against_served_carparks(monkeypatch):
    """One physical carpark, one pin — the snapshot must not re-pin a carpark
    that already has a served card, any more than the live path does."""
    monkeypatch.setattr(main, "_carpark_cache", _build_cache())
    _stub_total_overpass_failure(monkeypatch)
    _install_shipped_snapshot(
        monkeypatch,
        [
            # Sitting on served carpark "A" (1.3000, 103.8000).
            _snapshot_feature("node/10", 1.3000, 103.8000, name="Duplicate of A"),
            _snapshot_feature("node/11", 1.3020, 103.8020, name="Genuinely separate"),
        ],
    )

    results = await main.parking_osm(
        response=main.Response(), lat=1.3000, lon=103.8000, radius=500
    )

    assert [r.id for r in results] == ["osm_11"]


@pytest.mark.asyncio
async def test_snapshot_respects_the_requested_radius(monkeypatch):
    _stub_total_overpass_failure(monkeypatch)
    _install_shipped_snapshot(
        monkeypatch,
        [
            _snapshot_feature("node/20", 1.3324, 103.8475, name="Inside"),
            _snapshot_feature("node/21", 1.3600, 103.8700, name="Kilometres away"),
        ],
    )

    results = await main.parking_osm(
        response=main.Response(), lat=1.3323, lon=103.8474, radius=500
    )

    assert [r.id for r in results] == ["osm_20"]


@pytest.mark.asyncio
async def test_live_and_cached_tiers_still_outrank_the_snapshot(monkeypatch):
    """The floor is a floor: fresher tiers must keep winning."""
    cached_element = {
        "id": "osm_cached",
        "name": "Cached parking",
        "lat": 1.3324,
        "lon": 103.8475,
        "fee": None,
        "parking_type": None,
        "capacity": None,
    }
    key = (round(1.3323, 3), round(103.8474, 3), 500)
    _stub_total_overpass_failure(monkeypatch)
    monkeypatch.setattr(
        main,
        "_osm_cache",
        {key: (time.monotonic() - main.OSM_TTL_SECONDS - 1, [cached_element])},
    )
    _install_shipped_snapshot(
        monkeypatch, [_snapshot_feature("node/30", 1.3324, 103.8475, name="Snapshot")]
    )

    response = main.Response()
    results = await main.parking_osm(
        response=response, lat=1.3323, lon=103.8474, radius=500
    )

    assert [r.id for r in results] == ["osm_cached"]
    assert response.headers["x-ehparkleh-osm-state"] == "stale"


@pytest.mark.asyncio
async def test_osm_skips_upstream_entirely_while_every_endpoint_is_cooling(monkeypatch):
    """With every endpoint known to be failing there is nothing to gain by
    making the user wait on one of them, and a fair-use budget to lose. The
    snapshot answers immediately; cooldowns expire on their own, so live data
    resumes without anyone poking a host that is already refusing."""
    calls: list[str] = []
    _stub_total_overpass_failure(monkeypatch, calls=calls)
    _install_shipped_snapshot(
        monkeypatch, [_snapshot_feature("node/40", 1.3324, 103.8475, name="Snapshot")]
    )
    monkeypatch.setattr(
        main,
        "_overpass_cooldown",
        {ep: time.monotonic() + 60 for ep in main.OVERPASS_ENDPOINTS},
    )

    response = main.Response()
    results = await main.parking_osm(
        response=response, lat=1.3323, lon=103.8474, radius=500
    )

    assert calls == []
    assert [r.id for r in results] == ["osm_40"]
    assert response.headers["x-ehparkleh-osm-state"] == "snapshot"


@pytest.mark.asyncio
async def test_a_slow_endpoint_does_not_consume_every_later_endpoints_turn(monkeypatch):
    """The budget bug this repairs. The old check asked whether the budget was
    already spent *before* an attempt, so with a per-attempt timeout close to
    the total budget one hung endpoint used the whole allowance and every
    mirror behind it was skipped — in production that is exactly how the only
    healthy mirror never got tried. A slow first endpoint must still leave the
    next one a turn."""
    calls: list[str] = []

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            calls.append(url)
            if url == main.OVERPASS_ENDPOINTS[0]:
                await asyncio.sleep(kwargs["timeout"])
                raise main.httpx.ReadTimeout(
                    "hung", request=main.httpx.Request("POST", url)
                )
            return _elements_response(
                [
                    {
                        "type": "node",
                        "id": 55,
                        "lat": 1.3324,
                        "lon": 103.8475,
                        "tags": {"amenity": "parking", "name": "Healthy mirror"},
                    }
                ]
            )

    monkeypatch.setattr(main, "_osm_cache", {})
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main, "OVERPASS_ATTEMPT_TIMEOUT", 0.05)
    monkeypatch.setattr(main, "OVERPASS_TOTAL_BUDGET", 0.2)
    monkeypatch.setattr(main, "OVERPASS_MIN_ATTEMPT", 0.01)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())

    response = main.Response()
    results = await main.parking_osm(
        response=response, lat=1.3323, lon=103.8474, radius=500
    )

    assert calls[:2] == [main.OVERPASS_ENDPOINTS[0], main.OVERPASS_ENDPOINTS[1]]
    assert [r.id for r in results] == ["osm_55"]
    assert response.headers["x-ehparkleh-osm-state"] == "fresh"


@pytest.mark.asyncio
async def test_overpass_walk_never_overruns_its_total_budget(monkeypatch):
    """Every endpoint hangs. The walk must stop inside the budget rather than
    letting each attempt add its own timeout on top of it."""
    calls: list[str] = []

    class _OsmClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            calls.append(url)
            await asyncio.sleep(kwargs["timeout"])
            raise main.httpx.ReadTimeout("hung", request=main.httpx.Request("POST", url))

    monkeypatch.setattr(main, "_osm_cache", {})
    monkeypatch.setattr(main, "_overpass_cooldown", {})
    monkeypatch.setattr(main, "OVERPASS_ATTEMPT_TIMEOUT", 0.05)
    monkeypatch.setattr(main, "OVERPASS_TOTAL_BUDGET", 0.12)
    monkeypatch.setattr(main, "OVERPASS_MIN_ATTEMPT", 0.01)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **_kwargs: _OsmClient())
    _install_shipped_snapshot(
        monkeypatch, [_snapshot_feature("node/60", 1.3324, 103.8475, name="Snapshot")]
    )

    started = time.monotonic()
    await main.parking_osm(response=main.Response(), lat=1.3323, lon=103.8474, radius=500)
    elapsed = time.monotonic() - started

    assert elapsed < main.OVERPASS_TOTAL_BUDGET + 0.1, f"walk overran its budget: {elapsed:.3f}s"
    assert 0 < len(calls) < len(main.OVERPASS_ENDPOINTS), (
        "the budget should have stopped the walk before every endpoint was tried"
    )


def test_the_two_hosts_sharing_an_operator_are_not_listed_together():
    """overpass.kumi.systems and overpass.private.coffee resolved to the same
    IP (193.219.97.30) on 2026-08-27: back to back they look like two fallbacks
    while failing as one. A different operator has to sit between them."""
    hosts = [ep.split("//", 1)[-1].split("/", 1)[0] for ep in main.OVERPASS_ENDPOINTS]
    shared_operator = {"overpass.kumi.systems", "overpass.private.coffee"}
    adjacent = [set(pair) for pair in zip(hosts, hosts[1:])]
    assert shared_operator not in adjacent, f"same operator listed back to back: {hosts}"


def test_shipped_snapshot_is_present_and_plausible():
    """Guards the deploy: the crawl has to actually ship, and be whole. If this
    file goes missing or truncated the overlay silently loses its floor."""
    snapshot = main._load_osm_snapshot()

    assert snapshot is not None, f"{main.OSM_SNAPSHOT_FILE} did not load"
    assert len(snapshot) >= main.OSM_SNAPSHOT_MIN_FEATURES
    assert all(
        isinstance(e["id"], str) and e["id"].startswith("osm_") for e in snapshot
    )
    # Somewhere central and well mapped must have pins to offer.
    central = [
        e for e in snapshot if main.haversine(1.3048, 103.8318, e["lat"], e["lon"]) <= 1000
    ]
    assert len(central) > 5, "the crawl has no parking near Orchard Road"


def test_truncated_snapshot_is_refused_rather_than_served_as_no_parking_here(
    monkeypatch, tmp_path
):
    """Fail-closed, as restricted.py does: a half-written file must not read as
    'this neighbourhood has no parking'."""
    stub = tmp_path / "osm_parking.json"
    stub.write_text(json.dumps([_snapshot_feature("node/1", 1.33, 103.84)]))
    monkeypatch.setattr(main, "OSM_SNAPSHOT_FILE", stub)
    monkeypatch.setattr(main, "_osm_snapshot", None)
    monkeypatch.setattr(main, "_osm_snapshot_loaded", False)

    assert main._load_osm_snapshot() is None


def test_snapshot_element_skips_unusable_records():
    assert main._snapshot_element({"osm_id": "node/1", "lat": None, "lon": 103.8}) is None
    assert main._snapshot_element({"lat": 1.3, "lon": 103.8}) is None
    assert main._snapshot_element(
        {"osm_id": "node/7", "lat": 1.3, "lon": 103.8, "name": None}
    ) == {
        "id": "osm_7",
        "name": "Parking",
        "lat": 1.3,
        "lon": 103.8,
        "fee": None,
        "parking_type": None,
        "capacity": None,
    }

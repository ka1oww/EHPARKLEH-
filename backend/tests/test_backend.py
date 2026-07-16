"""Backend hardening tests: data load, category filtering, rates resolution,
and the availability TTL cache (with httpx mocked)."""

import sys
import time
from pathlib import Path

import pytest

# Make `backend` importable regardless of where pytest is invoked from.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def loaded_cache():
    """Load the real dataset into main._carpark_cache once for the module."""
    main._carpark_cache = main.load_carpark_records()
    return main._carpark_cache


@pytest.fixture(autouse=True)
def reset_avail_cache():
    """Clear the availability TTL cache before each test."""
    main._avail_cache["data"] = None
    main._avail_cache["fetched_at"] = 0.0
    yield


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

    async def get(self, url):
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
async def test_availability_refetches_after_ttl(monkeypatch):
    _FakeClient.calls = 0
    client = _FakeClient()

    await main.get_availability(client=client)
    assert _FakeClient.calls == 1

    # Expire the cache by rewinding fetched_at past the TTL.
    main._avail_cache["fetched_at"] = time.monotonic() - (main.AVAILABILITY_TTL_SECONDS + 1)

    await main.get_availability(client=client)
    assert _FakeClient.calls == 2


@pytest.mark.asyncio
async def test_availability_serves_stale_on_error():
    # Prime the cache with good data.
    _FakeClient.calls = 0
    client = _FakeClient()
    good = await main.get_availability(client=client)

    # Expire it, then fail the next fetch; should serve the stale snapshot.
    main._avail_cache["fetched_at"] = time.monotonic() - (main.AVAILABILITY_TTL_SECONDS + 1)

    class _FailingClient:
        async def get(self, url):
            raise RuntimeError("network down")

    out = await main.get_availability(client=_FailingClient())
    assert out == good

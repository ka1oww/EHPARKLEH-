#!/usr/bin/env python3
"""Assert that the live EhParkLeh backend is serving a specific commit.

Render publishes no deployment records to GitHub, and this repo holds no Render
API key to poll a deploy with, so a deploy is verified from the outside instead:
poll the public /health until the running process reports the commit that was
just pushed, then check the served dataset against the fingerprint documented in
README.md. Passing means the new code is live; a 200 alone does not.

Used by .github/workflows/deploy-backend.yml and safe to run by hand:

    python3 scripts/verify_live_deploy.py --commit "$(git rev-parse origin/main)"
"""

from __future__ import annotations

import argparse
import json
import ssl
import sys
import time
from typing import Any, Callable, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    import certifi
except ModuleNotFoundError:  # pragma: no cover - system Python may own its CA bundle
    TLS_CONTEXT = ssl.create_default_context()
else:
    TLS_CONTEXT = ssl.create_default_context(cafile=certifi.where())


DEFAULT_BASE_URL = "https://ehparkleh-backend.onrender.com"
DEFAULT_TIMEOUT_SECONDS = 1200.0
DEFAULT_POLL_SECONDS = 15.0
REQUEST_TIMEOUT_SECONDS = 60.0

# The dataset fingerprint. SE5L's free_parking_info was corrected to "NO" by
# PR #12, so the old value proves a stale carparks_enriched.json even when the
# code is current. If a future change moves this value, update both entries
# here and the README section that documents the same check.
FINGERPRINT_QUERY = "/api/carparks?lat=1.3694027&lon=103.8753456&radius=60"
FINGERPRINT_ID = "SE5L"
FINGERPRINT_FIELD = "free_parking_info"
FINGERPRINT_VALUE = "NO"

Fetcher = Callable[[str], Any]


class VerificationError(RuntimeError):
    """A failure that means the deploy is not proven live."""


def fetch_json(url: str) -> Any:
    """GET a URL and decode JSON, raising VerificationError on any failure."""
    request = Request(url, headers={"User-Agent": "EhParkLeh-deploy-verify/1"})
    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS, context=TLS_CONTEXT) as response:
            payload = response.read()
    except HTTPError as error:
        raise VerificationError(f"HTTP {error.code}") from error
    except (URLError, TimeoutError, ssl.SSLError, OSError) as error:
        raise VerificationError(f"request failed: {error}") from error
    try:
        return json.loads(payload)
    except (ValueError, UnicodeDecodeError) as error:
        raise VerificationError(f"response was not JSON: {error}") from error


def read_live_commit(health: Any) -> str:
    """Return the commit /health reports, or '' when it reports none."""
    if not isinstance(health, dict):
        return ""
    commit = health.get("commit")
    return commit.strip() if isinstance(commit, str) else ""


def wait_for_commit(
    base_url: str,
    expected_commit: str,
    *,
    timeout_seconds: float,
    poll_seconds: float,
    fetch: Fetcher = fetch_json,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    log: Callable[[str], None] = print,
) -> None:
    """Poll /health until it reports expected_commit, else raise."""
    deadline = now() + timeout_seconds
    attempts = 0
    last_commit: Optional[str] = None
    last_error: Optional[str] = None
    while True:
        attempts += 1
        try:
            health = fetch(f"{base_url}/health")
        except VerificationError as error:
            last_error = str(error)
            last_commit = None
            log(f"attempt {attempts}: backend not answering ({last_error})")
        else:
            last_error = None
            last_commit = read_live_commit(health)
            if last_commit == expected_commit:
                log(
                    f"Live backend is serving {expected_commit} "
                    f"after {attempts} check(s)."
                )
                return
            if last_commit:
                log(
                    f"attempt {attempts}: live commit is {last_commit}, "
                    f"want {expected_commit}"
                )
            else:
                log(f"attempt {attempts}: backend responded but reported no commit")
        if now() + poll_seconds >= deadline:
            break
        sleep(poll_seconds)

    if last_commit == "":
        raise VerificationError(
            "The backend responded but reported no commit, so this deploy CANNOT "
            "be verified. /health reads RENDER_GIT_COMMIT, which Render sets on a "
            "Git-backed service; an empty value means unknown, not up to date. "
            "Check the service's settings, then re-run."
        )
    seen = last_commit if last_commit else f"no successful response ({last_error})"
    raise VerificationError(
        f"The live backend never reported {expected_commit} within "
        f"{timeout_seconds:.0f}s (last seen: {seen}). The deploy was requested, so "
        "it most likely failed or is still building - open the service's Events "
        "and Logs in the Render dashboard to see why."
    )


def assert_dataset_fingerprint(
    base_url: str,
    *,
    fetch: Fetcher = fetch_json,
    log: Callable[[str], None] = print,
) -> None:
    """Check the served dataset, not just the code, is the current one."""
    carparks = fetch(f"{base_url}{FINGERPRINT_QUERY}")
    if not isinstance(carparks, list):
        raise VerificationError(
            f"The carparks endpoint did not return a list ({type(carparks).__name__}); "
            "the deploy is live but its data cannot be checked."
        )
    match = [c for c in carparks if isinstance(c, dict) and c.get("id") == FINGERPRINT_ID]
    if not match:
        raise VerificationError(
            f"Fingerprint carpark {FINGERPRINT_ID} is missing from the served "
            "dataset: the deploy is live but its enriched data is not what this "
            "commit builds."
        )
    value = match[0].get(FINGERPRINT_FIELD)
    if value != FINGERPRINT_VALUE:
        raise VerificationError(
            f"Fingerprint carpark {FINGERPRINT_ID} reports {FINGERPRINT_FIELD}="
            f"{value!r}, expected {FINGERPRINT_VALUE!r}: the deploy is serving a "
            "stale enriched dataset."
        )
    log(
        f"Enriched dataset fingerprint OK ({FINGERPRINT_ID} "
        f"{FINGERPRINT_FIELD}={FINGERPRINT_VALUE})."
    )


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True, help="the commit that must be live")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS)
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    commit = args.commit.strip()
    if not commit:
        print("--commit must not be empty", file=sys.stderr)
        return 2
    base_url = args.base_url.rstrip("/")
    try:
        wait_for_commit(
            base_url,
            commit,
            timeout_seconds=args.timeout,
            poll_seconds=args.poll,
        )
        assert_dataset_fingerprint(base_url)
    except VerificationError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

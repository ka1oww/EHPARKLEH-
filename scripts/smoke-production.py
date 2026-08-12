#!/usr/bin/env python3
"""Measure the public EhParkLeh search path without secrets or user data."""

from __future__ import annotations

import argparse
import json
import ssl
import statistics
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    import certifi
except ModuleNotFoundError:  # pragma: no cover - system Python may own its CA bundle
    TLS_CONTEXT = ssl.create_default_context()
else:
    TLS_CONTEXT = ssl.create_default_context(cafile=certifi.where())


DEFAULT_BASE_URL = "https://ehparkleh-backend.onrender.com"
FIXED_SEARCH = {"lat": "1.30000", "lon": "103.85000", "radius": "500"}
REQUIRED_TIMINGS = {"process_uptime", "availability", "ev", "local_filter", "total"}


def parse_server_timing(value: str) -> dict[str, dict[str, Any]]:
    metrics: dict[str, dict[str, Any]] = {}
    for item in value.split(","):
        parts = [part.strip() for part in item.strip().split(";")]
        if not parts or not parts[0]:
            continue
        metric: dict[str, Any] = {}
        for part in parts[1:]:
            if part.startswith("dur="):
                try:
                    metric["duration_ms"] = float(part.removeprefix("dur="))
                except ValueError:
                    pass
            elif part.startswith("desc="):
                metric["description"] = part.removeprefix("desc=").strip('"')
        metrics[parts[0]] = metric
    return metrics


def get_json(url: str, timeout: float) -> tuple[int, Any, dict[str, str], float]:
    request = Request(url, headers={"User-Agent": "EhParkLeh-production-smoke/1"})
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout, context=TLS_CONTEXT) as response:
            status = response.status
            body = json.load(response)
            headers = {key.lower(): value for key, value in response.headers.items()}
    except HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} from {url}") from exc
    except URLError as exc:
        raise RuntimeError(f"request failed for {url}: {exc.reason}") from exc
    return status, body, headers, (time.perf_counter() - started) * 1000


def run(base_url: str, samples: int, timeout: float, interval: float) -> dict[str, Any]:
    base_url = base_url.rstrip("/")
    health_status, health_body, _health_headers, health_ms = get_json(
        f"{base_url}/health", timeout
    )
    if (
        health_status != 200
        or not isinstance(health_body, dict)
        or health_body.get("status") != "ok"
    ):
        raise RuntimeError(f"health check was not ready: status={health_status}")

    observations = []
    search_url = f"{base_url}/api/carparks?{urlencode(FIXED_SEARCH)}"
    for index in range(1, samples + 1):
        status, body, headers, client_ms = get_json(search_url, timeout)
        if status != 200 or not isinstance(body, list):
            raise RuntimeError(f"search sample {index} returned an incompatible response")
        timing = parse_server_timing(headers.get("server-timing", ""))
        missing = REQUIRED_TIMINGS - timing.keys()
        if missing:
            raise RuntimeError(
                f"search sample {index} is missing Server-Timing metrics: {sorted(missing)}"
            )
        observations.append(
            {
                "sample": index,
                "client_ms": round(client_ms, 1),
                "result_count": len(body),
                "availability": timing["availability"],
                "ev": timing["ev"],
                "local_filter_ms": timing["local_filter"].get("duration_ms"),
                "server_total_ms": timing["total"].get("duration_ms"),
                "process": timing["process_uptime"],
            }
        )
        if index < samples and interval:
            time.sleep(interval)

    client_samples = [sample["client_ms"] for sample in observations]
    return {
        "target": base_url,
        "fixed_search": FIXED_SEARCH,
        "health": {
            "status": health_status,
            "client_ms": round(health_ms, 1),
            "carparks_loaded": health_body.get("carparks_loaded"),
        },
        "samples": observations,
        "summary": {
            "sample_count": samples,
            "client_min_ms": min(client_samples),
            "client_median_ms": round(statistics.median(client_samples), 1),
            "client_max_ms": max(client_samples),
        },
    }


def print_human(result: dict[str, Any]) -> None:
    health = result["health"]
    print(f"target={result['target']}")
    print(
        "health "
        f"status={health['status']} client_ms={health['client_ms']} "
        f"carparks_loaded={health['carparks_loaded']}"
    )
    print("sample client_ms results server_ms availability ev process_uptime_ms")
    for sample in result["samples"]:
        availability = sample["availability"]
        ev = sample["ev"]
        process = sample["process"]
        print(
            f"{sample['sample']} {sample['client_ms']} {sample['result_count']} "
            f"{sample['server_total_ms']} "
            f"{availability.get('description', 'unknown')}:{availability.get('duration_ms', '?')} "
            f"{ev.get('description', 'unknown')}:{ev.get('duration_ms', '?')} "
            f"{process.get('duration_ms', '?')}"
        )
    summary = result["summary"]
    print(
        "summary "
        f"n={summary['sample_count']} client_ms="
        f"{summary['client_min_ms']}/{summary['client_median_ms']}/{summary['client_max_ms']} "
        "(min/median/max; runner network included)"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--interval", type=float, default=0.25)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be at least 1")

    try:
        result = run(args.base_url, args.samples, args.timeout, args.interval)
    except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"smoke failed: {exc}", file=sys.stderr)
        return 1

    if args.as_json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print_human(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

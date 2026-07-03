#!/usr/bin/env python3
"""Fetch LTA OneMotoring's commercial-carpark parking-rate guide and save it to
onemotoring_rates.json.

This fills the rate gap for private/mall carparks that have no entry in the
HDB/URA/LTA datasets (ION Orchard, VivoCity, Suntec, and so on). LTA states the
rates are "only meant as a guide", so build_enriched.py keeps the raw strings and
tags any attached rate as indicative, crediting OneMotoring.

Source pages parking_rates.1.html .. parking_rates.8.html are distinct; 9+ alias
back to page 1. Run: backend/venv/bin/python enrich/crawl_onemotoring.py
"""
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "onemotoring_rates.json")
BASE = ("https://onemotoring.lta.gov.sg/content/onemotoring/home/owning/"
        "ongoing-car-costs/parking/parking_rates")
PAGES = range(1, 9)  # 1-8 distinct; 9+ alias back to page 1
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

# data-label -> our field name.
COLS = {
    "Car Park": "name",
    "Weekdays before 5/6pm": "weekday_before",
    "Weekdays After 5/6pm": "weekday_after",
    "Saturdays": "saturday",
    "Sundays/Public Holidays": "sunday_ph",
}


def _ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        raw = urllib.request.urlopen(req, timeout=40, context=_ctx()).read()
    except (ssl.SSLError, urllib.error.URLError):
        raw = urllib.request.urlopen(
            req, timeout=40, context=ssl._create_unverified_context()
        ).read()
    return raw.decode("utf-8", "replace")


class RowParser(HTMLParser):
    """Collect one dict per <tr>, keyed by each <td>'s data-label."""

    def __init__(self):
        super().__init__()
        self.rows = []
        self.cur = None
        self.key = None
        self.buf = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr":
            self.cur = {}
        elif tag == "td" and self.cur is not None:
            self.key = COLS.get((a.get("data-label") or "").strip())
            self.buf = []
        elif tag == "br" and self.key is not None:
            self.buf.append(" ")

    def handle_data(self, data):
        if self.key is not None:
            self.buf.append(data)

    def handle_endtag(self, tag):
        if tag == "td" and self.key is not None:
            self.cur[self.key] = re.sub(r"\s+", " ", "".join(self.buf)).strip()
            self.key = None
        elif tag == "tr" and self.cur is not None:
            if self.cur.get("name"):
                self.rows.append(self.cur)
            self.cur = None


def main():
    seen, order = {}, []
    for n in PAGES:
        parser = RowParser()
        parser.feed(fetch(f"{BASE}.{n}.html"))
        for row in parser.rows:
            key = re.sub(r"[^a-z0-9]", "", row["name"].lower())
            if key and key not in seen:
                seen[key] = row
                order.append(key)
        print(f"page {n}: {len(parser.rows)} rows (running unique {len(seen)})",
              file=sys.stderr)

    out = [seen[k] for k in order]
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print(f"unique carparks: {len(out)} -> {OUT}")


if __name__ == "__main__":
    main()

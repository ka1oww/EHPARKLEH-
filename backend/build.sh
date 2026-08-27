#!/usr/bin/env bash
# Deploy build step for the EhParkLeh backend.
# Installs dependencies and regenerates carparks_enriched.json from the
# committed source layers (gov + OSM + Google) so the served dataset is rebuilt
# by the deploy rather than trusted to be current in the commit.
#
# On Render the service uses rootDir: backend, so the build already starts in
# backend/ and the Build Command is:  ./build.sh
# The `cd` below resolves this script's own directory, so running it from
# anywhere (e.g. `backend/build.sh` locally) behaves identically.
set -euo pipefail
cd "$(dirname "$0")"
pip install -r requirements.txt
python enrich/build_enriched.py

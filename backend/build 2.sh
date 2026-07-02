#!/usr/bin/env bash
# Deploy build step for the EhParkLeh backend.
# Installs dependencies and regenerates carparks_enriched.json (git-ignored)
# from the committed source layers (gov + OSM + Google) so the served data is
# fresh and the ~3MB artifact never lives in the repo.
#
# On Render, set the Build Command to:  cd backend && ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
pip install -r requirements.txt
python enrich/build_enriched.py

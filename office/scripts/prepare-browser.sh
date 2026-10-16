#!/usr/bin/env bash
# For Ubuntu 24.04; unpack libraries inside the repository without installing system packages.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache/system-packages .cache/system-libs .cache/runtime
PLAYWRIGHT_BROWSERS_PATH=.cache/browsers npm exec --cache .cache/npm -- playwright install chromium
(
  cd .cache/system-packages
  apt-get download libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libatspi2.0-0t64 libxrender1 libxi6
  for ofis_deb in *.deb; do dpkg-deb -x "$ofis_deb" ../system-libs; done
)

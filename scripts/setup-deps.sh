#!/usr/bin/env bash
set -euo pipefail

# setup-deps.sh
# Installs system packages required to run the whatsapp-web.js headless service on Debian/Ubuntu/WSL/Raspbian.
# Run as: npm run setup

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs sudo to install system packages. You will be prompted for your password."
  SUDO='sudo'
else
  SUDO=''
fi

${SUDO} apt update

# Candidate list of packages to try to install. Some package names differ between distros/versions.
PKGS=(
  git
  build-essential
  curl
  ca-certificates
  chromium-browser
  chromium
  chromium-chromedriver
  libnss3
  libnspr4
  libatk1.0-0
  libx11-xcb1
  libxcomposite1
  libxdamage1
  libxrandr2
  libasound2t64
  libgbm1
  libxss1
  libgtk-3-0
  fonts-liberation
  libxrender1
  libxtst6
  libfontconfig1
)

AVAILABLE=()
for pkg in "${PKGS[@]}"; do
  # Check if apt knows about this package and has a candidate
  if apt-cache policy "$pkg" >/dev/null 2>&1; then
    CAND=$(apt-cache policy "$pkg" | awk '/Candidate:/ {print $2}') || true
    if [ -n "$CAND" ] && [ "$CAND" != "(none)" ]; then
      AVAILABLE+=("$pkg")
    else
      echo "Skipping unavailable package: $pkg"
    fi
  else
    echo "Skipping unknown package: $pkg"
  fi
done

if [ ${#AVAILABLE[@]} -gt 0 ]; then
  echo "Installing available packages: ${AVAILABLE[*]}"
  ${SUDO} apt install -y "${AVAILABLE[@]}"
else
  echo "No available packages found to install. Skipping apt install step."
fi

# Ensure Node.js present (if not, install Node 18)
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found — installing Node.js 18.x"
  curl -fsSL https://deb.nodesource.com/setup_18.x | ${SUDO} -E bash -
  ${SUDO} apt install -y nodejs
fi

# Install npm dependencies
echo "Installing npm dependencies"
npm install

echo "All done. If running on WSL, ensure WSL2 is used. Start with: npm start"

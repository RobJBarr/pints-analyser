Pints Tracker — WhatsApp Web listener (Raspberry Pi)

Overview

This project runs a headless WhatsApp Web listener (whatsapp-web.js) on a Raspberry Pi. It listens for image and text messages in chats, detects pints posted as images (optionally with a number in the caption or immediately following message), applies these rules:

- Images represent pints. If a number appears in the image caption or in the immediately following text message from the same sender, that number is used; otherwise a single pint is assumed.
- If a user posts 3 pints in a row, the 3rd pint counts double.
- Any image/corresponding message marked CANCEL (send a text message "CANCEL" from the same sender) will mark the last image from that sender as cancelled and ignore it.
- If the image or caption includes a plane emoji (✈️), that pint counts double.

The service persists message history in messages.json and writes aggregated totals to pints.json. If Git push credentials are configured on the Pi, the service commits pints.json/messages.json back to the repository so GitHub Pages can serve pints.json for the static site (index.html + app.js included).

Repository contents

- index.html, app.js — Simple GitHub Pages frontend that reads pints.json and displays totals.
- src/index.js — Node service using whatsapp-web.js to listen, download media, and compute pints.
- package.json — Node dependencies and start script.
- messages.json, pints.json — runtime data files (created/updated by the service).
- deploy/pints-whatsapp.service — systemd unit file (edit WorkingDirectory/ExecStart paths before installing).
- DEPLOY_PI.md — longer Raspberry Pi deployment notes and Cloudflare Tunnel instructions.

Quickstart (Raspberry Pi)

1. Prepare the Pi

sudo apt update && sudo apt install -y git build-essential curl ca-certificates

Install Chromium and supporting libraries used by puppeteer:

sudo apt install -y chromium-browser libnss3 libatk1.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libasound2 libgbm1 libxss1 libgtk-3-0

Install Node.js (18+ recommended):

curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

2. Clone repo and install deps

# as pi user
cd /home/pi
git clone git@github.com:OWNER/REPO.git pints-analyser   # update OWNER/REPO
cd pints-analyser
npm ci

3. Start interactively and scan QR

npm start

On first run the app prints a QR in the console and exposes /qr on port 3000. Open the QR in your phone (WhatsApp -> Linked devices -> Link a device) and scan. After scanning the session is stored in .wwebjs_auth and future runs won’t require scanning.

4. Install as a systemd service (optional)

Edit deploy/pints-whatsapp.service and change WorkingDirectory and ExecStart to your repo path (e.g., /home/pi/pints-analyser):

sudo cp deploy/pints-whatsapp.service /etc/systemd/system/pints-whatsapp.service
sudo systemctl daemon-reload
sudo systemctl enable --now pints-whatsapp.service
sudo journalctl -u pints-whatsapp -f

5. (Optional) Expose QR temporarily for remote scanning — Cloudflare Tunnel

If you need to scan the QR remotely, expose the /qr endpoint temporarily via Cloudflare Tunnel (or ngrok). High-level steps with cloudflared:

- Install cloudflared (ARM binary or package).
- Authenticate: cloudflared tunnel login
- Create a tunnel and map a hostname to http://localhost:3000 (see DEPLOY_PI.md for example config).
- After scanning, remove the route for security.

6. Push access from Pi for automatic updates

The service uses `git commit` and `git push` to update pints.json. Configure push access by adding an SSH key (ssh-keygen -t ed25519) and adding the public key to GitHub. Test `git push` manually.

GitHub Pages

Enable GitHub Pages on your repository (Settings → Pages → Source: main branch / root) to publish index.html and let the site load pints.json from the repo root. The static UI periodically fetches pints.json to display current totals.

Configuration and environment

- PORT (env) — Express status server port (default 3000).
- PUPPETEER_EXECUTABLE_PATH — if chromium is in a non-standard path set this env var prior to starting.
- .gitignore contains .wwebjs_auth and media/ to avoid leaking session files and downloaded media.

Security, privacy & compliance

- Ensure you have consent from group participants before monitoring messages.
- Keep .wwebjs_auth private (it contains session credentials). Do not commit it.
- If exposing the QR or the status page, use temporary, authenticated tunnels and remove them after use.
- Use a dedicated GitHub user or token for automated pushes if you prefer HTTPS.

Troubleshooting

- If puppeteer cannot start: confirm Chromium is installed and accessible to the node process. Set PUPPETEER_EXECUTABLE_PATH if needed.
- If media download fails occasionally, check network and that the running session is healthy (relink if needed).
- If git push fails, re-check remote URL and SSH key or PAT credentials.

Extending and alternatives

- Replace "CANCEL" convention with more advanced reaction detection if the library gains reaction metadata in the future.
- Batch commits or rate-limit pushes if message rate is high (to avoid API limits).
- Add a small web admin UI to review/adjust inferred events before pushing.

Support

See DEPLOY_PI.md for a longer step-by-step deployment guide, Cloudflare Tunnel details, and troubleshooting tips.
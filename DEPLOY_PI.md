Pints WhatsApp Listener — Raspberry Pi deployment

Overview

This guide sets up a Raspberry Pi to run a headless WhatsApp Web listener using whatsapp-web.js. The service keeps a persistent WhatsApp session, listens for image/text messages, applies the pint rules and writes pints.json and messages.json in the repo, committing updates to GitHub. A small status server exposes /status and /qr (optional) for remote checks.

Prerequisites
- Raspberry Pi OS (Debian-based)
- SSH access or local shell
- Github repo cloned at /home/pi/pints-analyser (update paths below as needed)
- Git push access from the Pi (SSH key added to GitHub or credential helper configured)

Install system dependencies

sudo apt update && sudo apt install -y git build-essential curl ca-certificates

Install Chromium and required libs (for puppeteer):

sudo apt install -y chromium-browser libnss3 libatk1.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libasound2 libgbm1 libxss1 libgtk-3-0

Install Node.js (18+ recommended)

curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

Clone repository

# run as pi user
cd /home/pi
git clone git@github.com:OWNER/REPO.git pints-analyser
cd pints-analyser

Install npm dependencies

npm ci

Configuration

- Ensure .gitignore contains .wwebjs_auth so session data persists locally but you do not accidentally commit it.
- Ensure git origin is set and pi user has push access (add SSH key: ssh-keygen -t ed25519, then paste ~/.ssh/id_ed25519.pub into GitHub Settings → SSH and GPG keys).
- If you prefer HTTPS + PAT, configure git credential store but SSH is recommended.

Start service manually (first run)

# run interactively to scan QR
npm start

The first time, the app will emit a QR in the console; scan it with WhatsApp mobile (Menu -> Linked Devices -> Link a device). After scanning, the session will persist in .wwebjs_auth/ and subsequent runs will not require QR scanning.

Install as systemd service

# copy the provided unit file to system location (update WorkingDirectory and ExecStart paths as needed)
sudo cp deploy/pints-whatsapp.service /etc/systemd/system/pints-whatsapp.service
sudo systemctl daemon-reload
sudo systemctl enable --now pints-whatsapp.service

Check status

sudo journalctl -u pints-whatsapp -f

Security & notes

- WhatsApp Web sessions are tied to the linked device; keep the .wwebjs_auth folder private (it's in .gitignore).
- You must comply with WhatsApp terms of service and ensure group members consent to being monitored.
- If your Pi is headless and you cannot scan the QR locally, consider exposing the /qr endpoint via a secure tunnel (Cloudflare Tunnel) so you can open the QR image remotely, scan, then close the tunnel.

Cloudflare Tunnel (optional) — expose /qr temporarily

1) Install cloudflared (see https://developers.cloudflare.com/cloudflare-one/tutorials/runners/)

curl -L -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm
sudo chmod +x /usr/local/bin/cloudflared

2) Authenticate and create a tunnel (runs interactively in your account)

/usr/local/bin/cloudflared tunnel login
/usr/local/bin/cloudflared tunnel create pints-trunnel

3) Route a public subdomain to your local port 3000 (the app's /qr endpoint). Example config (~/.cloudflared/config.yml):

tunnel: <TUNNEL-UUID>
credentials-file: /home/pi/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: pints-yourname.example.com
    service: http://localhost:3000
  - service: http_status:404

4) Run the tunnel as a service

sudo cloudflared service install
sudo systemctl start cloudflared

Now visiting https://pints-yourname.example.com/qr will show the QR image (only while last QR is available). Remove the route after scanning for security.

Hosting results online for free

- The service commits pints.json and messages.json back to your GitHub repo. Use GitHub Pages (free) to serve index.html and pints.json. The repo already contains index.html and app.js that read pints.json.
- Enable Pages in your repo settings (branch: main, folder: /) and your site will auto-update when pints.json is pushed.

Troubleshooting

- Puppeteer errors: verify Chromium path; puppeteer uses system Chromium. You can set PUPPETEER_EXECUTABLE_PATH env var if needed.
- Media download failures: sometimes Meta blocks direct fetch; whatsapp-web.js normally handles media via the web session.
- If pushes fail: check git remote and SSH key. Run git push manually to see errors.

Further improvements

- Add webhook to push batched updates rather than per-message commits.
- Improve reaction handling if whatsapp-web.js exposes reaction metadata in future releases.
- Add an admin UI to correct/cancel events.


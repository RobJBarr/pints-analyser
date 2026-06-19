Pints Tracker (GitHub Pages + WhatsApp Business Cloud API)

Overview

This project implements a GitHub Pages site that shows per-participant pint totals. Incoming WhatsApp messages are delivered by Meta to a webhook-relay (e.g., Pipedream), which forwards them as repository_dispatch events to this repository. A GitHub Actions workflow processes each event, updates messages.json and pints.json, and commits the aggregated pints.json. The site (index.html) reads pints.json.

Setup (high level)

1. Create a GitHub repository and push this project.
2. Enable GitHub Pages on the repo (branch: main / root or gh-pages) to serve index.html.
3. Create a Pipedream HTTP source (or similar) that accepts WhatsApp Business Cloud webhooks.
   - Configure your Meta app to use the Pipedream endpoint as the webhook URL.
4. In Pipedream, forward incoming webhook bodies to GitHub repository dispatch:
   - POST https://api.github.com/repos/OWNER/REPO/dispatches
   - Headers: Authorization: token YOUR_PERSONAL_ACCESS_TOKEN
   - Body: { "event_type": "whatsapp_event", "client_payload": <whatsapp-webhook-body> }
5. When a new message arrives, the workflow triggers and updates pints.json.

Notes and limitations

- WhatsApp Business Cloud API delivers incoming messages via webhooks — this design uses a webhook relay so you don't need a continuously-running machine.
- Excluding messages via cancel-reaction depends on the webhook containing reaction metadata. If reactions are not present, provide a convention (e.g., a follow-up message containing "CANCEL" or react via a message) and adjust Pipedream mapping accordingly.
- The processor uses heuristics: it treats image messages as pint events, looks for a number in the image text or the immediate next text message, defaults to 1 if no number is found, doubles for plane emoji, and applies the 3-in-a-row rule.

Security

- Pipedream (or your chosen relay) will need a GitHub token to call repository_dispatch. Keep that token secret.
- The workflow uses the default GITHUB_TOKEN to commit results back to the repo.

If you want, the next step is to:
- Provide the repository owner/name so the README can be updated with exact steps, and
- I can create a sample Pipedream mapping snippet for sending the dispatch with the payload format expected here.

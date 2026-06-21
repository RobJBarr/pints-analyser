WhatsApp Web extractor (browser script)

Use this when viewing a chat in WhatsApp Web (desktop). Open Developer Tools (Ctrl+Shift+I), switch to Console, paste the script in tools/whatsapp_web_extractor.js and run it.

What it does
- Extracts each message's timestamp, sender, text, quoted message, media (image src -> dataURL when available) and reaction heuristics.
- Applies the pints rules: images = pint events, numbers in caption or next text message count as pints, plane emoji doubles, 3-in-a-row doubles the 3rd, CANCEL reactions/text ignore messages.
- Downloads chat_pints.json with raw messages, inferred events, and totals.

How to use
1. Open WhatsApp Web and open the chat to extract.
2. Open Developer Tools → Console.
3. Open this repo's tools/whatsapp_web_extractor.js in a text editor, copy contents, paste into the console and press Enter.
4. The script will download chat_pints.json. Transfer that file to your Pi or repo and commit if you want.

Limitations
- DOM structure may change; script is best-effort and may require tweaks if WhatsApp Web updates.
- Image fetch may fail for some blob URLs depending on browser policy.
- Reaction detection is heuristic; WhatsApp Web does not expose an easy API via DOM for reactions, so some reactions may be missed.

If you want, the service can accept uploaded chat_pints.json (add a POST /upload endpoint) so you can push extracted files directly to the Pi. Ask to implement that if you'd like.

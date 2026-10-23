# Hushmile web viewer

A static page that shows a Hushmile road trip to family without the app.

Open `https://nkr741.github.io/hushmile-web/#ABCD-EFGH.KEY` (app 1.4.1+:
the Journey Code and the journey's link key) or the older
`https://nkr741.github.io/hushmile-web/#ABCD-EFGH` (the code only). A
code-only page posts an encrypted "seen" on the old channel, so the
traveller's phone writes the old channel for it and escrows the link key on
api.hushmile.com, wrapped with scrypt(code, per-journey salt) and never
readable by the server; the page asks for it every 4 minutes (the server
rate-limits lookups) and then reads the new channel. Journeys from older apps
have no key and are read as before. See docs/LINK_KEY.md in the app repo. The fragment is never sent to the web server. The page polls
Hushmile's relay (api.hushmile.com) and ntfy.sh once a minute, keeps the newest, decrypts in the browser (PBKDF2-HMAC-SHA256 150,000
rounds, AES-256-GCM, the same scheme as the app) and shows the status
sentence, last update and kilometres left.

- `index.html`, `app.js`: the page
- `hushmile-viewer.js`: crypto, relay and sentence logic
- `privacy.html`: privacy policy for the app and this page

No build step, no secrets, no server. The Content-Security-Policy only allows
connections to api.hushmile.com and ntfy.sh, and images from
tile.openstreetmap.org (the map). Leaflet 1.9.4 is vendored in `vendor/`
(BSD-2-Clause, see `vendor/LICENSE-leaflet.txt`); tiles are requested with
`referrerPolicy: strict-origin`, as OpenStreetMap's tile policy asks.

Map: blue line = the planned route, grey dots = earlier places (the trail),
marker = the last known place with its age. Nothing on the map is live.

Tests: `node --test test/`

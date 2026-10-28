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

`safety-config.js` is generated in the app repo from `config/safety.json`
(SOS timing, emergency numbers by country, night hours, battery bands) by
`python3 tool/safety_to_code.py`; copy it here with the other viewer files.

## Map

`map-view.js` draws the journey map; its settings are in `map-config.js`.
MapLibre GL JS 6.16.0 (vendored in `vendor/`, BSD-3-Clause,
`vendor/LICENSE-maplibre.txt`) with OpenFreeMap vector tiles: the Positron
style by day and Dark at night. OpenFreeMap is free, needs no key, has no
limit on map views and allows commercial use; its attribution is shown on the
map. The library (about 1.6 MB, cached by the browser) is loaded only when
there is a map to show. Labels are the Latin (English) names: MapLibre cannot
yet join Telugu or Hindi letters, so labels in those scripts would look
broken. A browser without WebGL gets the older Leaflet 1.9.4 map with
OpenStreetMap tiles (`referrerPolicy: strict-origin`, as OSM's tile policy
asks).

On the map: blue line = the planned route; green line and dots = the road
taken so far (the trail the phone sent); round marker = the last known place
(arrow: its heading; halo: how sure the phone was), with its age under the
map. A button under the zoom buttons fits the whole route again.

Why not the Google Maps JavaScript API here: it is billed per map load after
10,000 free loads a month (Dynamic Maps, USD 7 per 1,000 after that), and
every family member opening a link is a load. OpenFreeMap costs nothing at
any volume.

# Hushmile web viewer

A static page that shows a Hushmile road trip to family without the app.

Open `https://nkr741.github.io/hushmile-web/#ABCD-EFGH` with the Journey Code
after the `#`. The fragment is never sent to the web server. The page polls
Hushmile's relay (api.hushmile.com) and ntfy.sh once a minute, keeps the newest, decrypts in the browser (PBKDF2-HMAC-SHA256 150,000
rounds, AES-256-GCM, the same scheme as the app) and shows the status
sentence, last update and kilometres left.

- `index.html`, `app.js`: the page
- `hushmile-viewer.js`: crypto, relay and sentence logic
- `privacy.html`: privacy policy for the app and this page

No build step, no secrets, no server. The Content-Security-Policy only allows
connections to api.hushmile.com and ntfy.sh.

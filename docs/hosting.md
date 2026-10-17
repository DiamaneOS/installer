# Hosting the web installer

The installer is served at `https://diamaneos.de/install/web/`, as GrapheneOS serves its installer at
`grapheneos.org/install/web`. The page carries its own guide text.

- The rest of the website runs no scripts and its Permissions-Policy turns USB off, so only the
  installer page can use the browser's USB permission for the origin.
- WebUSB works only over HTTPS, or on localhost for tests.

## How the website takes it

- The website repository holds `web/` without `nginx/`, `test/` and `serve.py` at
  `static/install/web/`, and this repository's three header files under `server/nginx/`.
- `installer.sha256` there names the installer commit and the SHA-256 of every file. The website's
  build check fails if a file differs or one is missing or added.
- A new installer version is a new website commit: import the signed installer commit, build, check
  and deploy the website.

## What the server needs

- **nginx:** the locations in [`web/nginx/example.conf`](../web/nginx/example.conf) in the
  website's HTTPS server, with `base.conf`, `installer.conf` and `general.conf`.
- **Keepalive:** the website server keeps connections open (`keepalive_requests 64`,
  `keepalive_timeout 15s`). With the hardened http block's `keepalive_timeout 0`, each HTTP/2
  connection ends after one request and browsers give up on some of the page's modules.
- **Files only:** no server code, no cookies, no request logs. The page loads nothing from other
  hosts. Its only network requests download a release from `releases.diamaneos.de`.

## Headers

- The installer page gets `installer.conf`: scripts, styles, fonts, images and workers from its
  own origin only, Trusted Types with the one `installer` policy, and `connect-src` only for
  `https://releases.diamaneos.de`.
- Its Permissions-Policy allows `usb`, `screen-wake-lock` and `clipboard-write` for its own origin
  and nothing else.
- Every other installer file gets `general.conf`: the same sources without workers, no USB and no
  Trusted Types policy.
- Every installer response gets `base.conf`: HSTS, `nosniff`, no referrer, same-origin COOP, COEP
  and CORP, and no framing.
- The website's own headers do not apply under `/install/web/`.
- `.mjs` files must be served as `text/javascript`, or the browser refuses fastboot.js.

## The release host

The release download fetches from `releases.diamaneos.de` in CORS mode, without cookies.

- The channel files (`/FP6-stable`), the factory ZIPs and their `.sig` files need
  `Access-Control-Allow-Origin: *`, or the website's origin.
- The requests are plain GETs, so there is no preflight and no other CORS header is needed.
- `Cross-Origin-Resource-Policy: same-origin` may stay. Browsers check it only for requests without
  CORS.

## Checking a deployment

Fetch every file under `/install/web/`, compare its SHA-256 with the commit's file, and check the
headers of `/install/web/`, one script and one website page.

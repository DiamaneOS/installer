# Hosting the web installer

The installer needs a host name of its own, for example `install.diamaneos.de`.

- The website's Content-Security-Policy allows no scripts, and the installer is a script.
- A separate origin keeps the browser's USB permission for the phone away from the website.
- WebUSB works only over HTTPS, or on localhost for tests.

## What the host needs

- **DNS:** A and AAAA records for the name, pointing at the web server. If the zone has CAA
  records, they must allow the certificate's issuer.
- **TLS:** a certificate for the name, for example from Let's Encrypt through the HTTP-01 webroot
  the example server answers on port 80.
- **nginx:** the server in [`web/nginx/example.conf`](../web/nginx/example.conf), with `base.conf`,
  `installer.conf` and `general.conf` copied to `installer/` in the nginx configuration directory.
- **Files only:** no server code, no cookies, no request logs. The page loads nothing from other
  hosts and makes no network requests.

## Headers

- The installer page gets `installer.conf`: scripts, styles, images and workers from its own
  origin only, Trusted Types with the one `installer` policy, no `connect-src`.
- Its Permissions-Policy allows `usb` and `screen-wake-lock` for its own origin and nothing else.
- Every other file gets `general.conf`: no USB, no workers, no Trusted Types policy.
- Every response gets `base.conf`: HSTS, `nosniff`, no referrer, same-origin COOP, COEP and CORP,
  and no framing.
- `.mjs` files must be served as `text/javascript`, or the browser refuses fastboot.js.

## Deploying

1. Take a signed commit of this repository and check its signature.
2. Copy `web/` without `nginx/`, `test/` and `serve.py` into a new read-only directory named after
   the commit, for example `/srv/diamaneos-installer/releases/<commit>`.
3. Install the server and the header files. Test the nginx configuration as the user nginx runs as,
   not as root, then reload nginx.
4. Point `/srv/diamaneos-installer/current` at the new directory. Keep the previous one for a
   rollback.
5. Fetch every file from the public name, compare its SHA-256 with the commit's file, and check the
   headers of `/`, `/index.html` and one script.

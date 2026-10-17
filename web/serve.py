#!/usr/bin/env python3
"""Serve the web installer on localhost, with the headers in nginx/, for a test.

Browsers allow WebUSB on http://localhost, so no certificate is needed.
--releases DIR also serves DIR as the release host on the next port, with the
release host's cross-origin headers, and points the page at it. DIR holds the
channel file, the factory ZIP, its signature and the allowed_signers line of the
key that made it (test/fixture-release, for example).
"""
import argparse
import functools
import http.server
import pathlib
import re
import threading

ROOT = pathlib.Path(__file__).resolve().parent
INSTALLER_PAGES = {'/', '/index.html'}
HIDDEN = ('/nginx/', '/test/', '/serve.py')
RELEASES = 'https://releases.diamaneos.de'
# What releases.diamaneos.de sends on its channel files, factory ZIPs and signatures.
RELEASE_HEADERS = [('Access-Control-Allow-Origin', '*'), ('Cross-Origin-Resource-Policy', 'same-origin'),
                   ('Cross-Origin-Embedder-Policy', 'require-corp'), ('X-Content-Type-Options', 'nosniff')]


def headers(name):
    text = (ROOT / 'nginx' / 'base.conf').read_text() + (ROOT / 'nginx' / name).read_text()
    # HSTS only applies over HTTPS.
    return [(key, value) for key, value in re.findall(r'^add_header (\S+) "([^"]*)" always;$', text, re.M)
            if key != 'Strict-Transport-Security']


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
                      '.mjs': 'text/javascript', '.map': 'application/json', '': 'text/plain; charset=utf-8'}
    releases = None

    def send_head(self):
        path = self.path.split('?')[0]
        if path.startswith(HIDDEN) or (path.endswith('/') and path != '/'):
            self.send_error(404)
            return None
        return super().send_head()

    def do_GET(self):
        if self.releases is None or self.path.split('?')[0] != '/js/release.js':
            return super().do_GET()
        url, signer = self.releases
        text = (ROOT / 'js/release.js').read_text().replace(f'"{RELEASES}"', f'"{url}"')
        text = re.sub(r'FACTORY_SIGNER = "[^"]*"', f'FACTORY_SIGNER = "{signer}"', text)
        body = text.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/javascript')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        page = self.path.split('?')[0] in INSTALLER_PAGES
        for key, value in headers('installer.conf' if page else 'general.conf'):
            if self.releases is not None:
                value = value.replace(f'connect-src {RELEASES}', f'connect-src {self.releases[0]}')
            self.send_header(key, value)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class ReleaseHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        if not re.fullmatch(r'/[A-Za-z0-9][A-Za-z0-9._-]*', self.path) or self.path == '/allowed_signers':
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        for key, value in RELEASE_HEADERS:
            self.send_header(key, value)
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=8780)
    parser.add_argument('--releases', type=pathlib.Path, help='a folder to serve as the release host')
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=str(ROOT))
    if args.releases:
        url = f'http://localhost:{args.port + 1}'
        Handler.releases = (url, (args.releases / 'allowed_signers').read_text().strip())
        mirror = http.server.ThreadingHTTPServer(
            ('127.0.0.1', args.port + 1), functools.partial(ReleaseHandler, directory=str(args.releases)))
        threading.Thread(target=mirror.serve_forever, daemon=True).start()
        print(f'Serving {args.releases} as the release host on {url}/')
    with http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        print(f'Serving the web installer on http://localhost:{args.port}/')
        server.serve_forever()


if __name__ == '__main__':
    main()

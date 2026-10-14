#!/usr/bin/env python3
"""Serve the web installer on localhost, with the headers in nginx/, for a test.

Browsers allow WebUSB on http://localhost, so no certificate is needed.
"""
import argparse
import functools
import http.server
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
INSTALLER_PAGES = {'/', '/index.html'}
HIDDEN = ('/nginx/', '/test/', '/serve.py')


def headers(name):
    text = (ROOT / 'nginx' / 'base.conf').read_text() + (ROOT / 'nginx' / name).read_text()
    # HSTS only applies over HTTPS.
    return [(key, value) for key, value in re.findall(r'^add_header (\S+) "([^"]*)" always;$', text, re.M)
            if key != 'Strict-Transport-Security']


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
                      '.mjs': 'text/javascript', '.map': 'application/json', '': 'text/plain; charset=utf-8'}

    def send_head(self):
        path = self.path.split('?')[0]
        if path.startswith(HIDDEN) or (path.endswith('/') and path != '/'):
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        page = self.path.split('?')[0] in INSTALLER_PAGES
        for key, value in headers('installer.conf' if page else 'general.conf'):
            self.send_header(key, value)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8780)
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        print(f'Serving the web installer on http://localhost:{args.port}/')
        server.serve_forever()


if __name__ == '__main__':
    main()

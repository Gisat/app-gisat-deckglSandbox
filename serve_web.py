import http.server
import json
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
DIST_DIR = '/app/dist'

VITE_BASE = os.environ.get('VITE_BASE', '/')
if VITE_BASE and not VITE_BASE.endswith('/'):
    VITE_BASE += '/'
if VITE_BASE and not VITE_BASE.startswith('/'):
    VITE_BASE = '/' + VITE_BASE

BACKEND_API_URL = os.environ.get('BACKEND_API_URL', '')


class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST_DIR, **kwargs)

    def translate_path(self, path):
        if VITE_BASE != '/' and path.startswith(VITE_BASE):
            path = '/' + path[len(VITE_BASE):]
        return super().translate_path(path)

    def _strip_base(self, path):
        if VITE_BASE != '/' and path.startswith(VITE_BASE):
            return '/' + path[len(VITE_BASE):]
        return path

    def do_GET(self):
        stripped = self._strip_base(self.path)

        if stripped == '/config.js':
            self._serve_config()
            return

        # Redirect base root to index.html
        if VITE_BASE != '/' and self.path in (VITE_BASE, VITE_BASE.rstrip('/')):
            self.path = VITE_BASE.rstrip('/') + '/index.html'

        if VITE_BASE != '/' and self.path.endswith('.html'):
            return self._serve_html_with_base()

        path = self.translate_path(stripped)
        if not os.path.exists(path) and '.' not in os.path.basename(stripped):
            self.path = VITE_BASE.rstrip('/') + '/index.html'
            if VITE_BASE != '/':
                return self._serve_html_with_base()

        return super().do_GET()

    def _serve_config(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        lines = [
            f'window.VITE_BASE = {json.dumps(VITE_BASE)};',
            f'window.BACKEND_API_URL = {json.dumps(BACKEND_API_URL or None)};',
            '',
        ]
        self.wfile.write('\n'.join(lines).encode())

    def _serve_html_with_base(self):
        path = self.translate_path(self._strip_base(self.path))
        with open(path, 'rb') as f:
            content = f.read()
        base_tag = f'<base href="{VITE_BASE}">'.encode()
        content = content.replace(b'<head>', b'<head>\n    ' + base_tag)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(content)


print(f'Serving {DIST_DIR} on http://0.0.0.0:{PORT} (base: {VITE_BASE})')
http.server.HTTPServer(('0.0.0.0', PORT), SPAHandler).serve_forever()

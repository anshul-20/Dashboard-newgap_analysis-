#!/bin/bash
PORT=9844
HOST="148.251.177.113"
echo "Starting News Gap UI on Port $PORT (Binding to $HOST)"

# Use Python with no-cache headers so browsers always get fresh JS/CSS files.
# This prevents the stale-tab issue where refreshing an old tab shows old data.
python3 -c "
import http.server, functools

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

http.server.HTTPServer(('$HOST', $PORT), NoCacheHandler).serve_forever()
"

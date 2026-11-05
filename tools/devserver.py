"""Static dev server for the prototype/creator: like `python -m http.server`, but with
`Cache-Control: no-store` so browsers never run stale ES modules after an edit.

Usage:  python tools/devserver.py [port]    (serves the Project DND folder on 127.0.0.1)
"""
import functools
import http.server
import pathlib
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5180
    root = pathlib.Path(__file__).resolve().parent.parent
    handler = functools.partial(NoCache, directory=str(root))
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()

"""Carnival Clicker - local server.

Holds the ESP32 links, serves the game, and streams controller events to the
browser over Server-Sent Events.  Stdlib only apart from pyserial, so there is
nothing to install beyond what Pot Mender already needed.

Why a server at all, rather than the browser talking to the ESP32 itself:
the serial layer here already knows which ports are safe to open, and keeping
it in a separate process means a serial hiccup cannot take the renderer down -
which matters when the thing runs unattended at a carnival all day.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import esp32link

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
SCORES = ROOT / "scores.json"
MAX_SCORES = 500

hub = None
subscribers = []
subs_lock = threading.Lock()


# ---------------------------------------------------------------- scores
def load_scores():
    try:
        with open(SCORES, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def save_scores(rows):
    """Write on every round, not on exit - a kiosk gets power-cycled."""
    tmp = SCORES.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rows[:MAX_SCORES], fh, indent=1)
    os.replace(tmp, SCORES)


def add_score(entry):
    rows = load_scores()
    rows.append(entry)
    rows.sort(key=lambda r: -int(r.get("score", 0)))
    save_scores(rows)
    return rows[:MAX_SCORES]


# ---------------------------------------------------------------- events
def broadcast(event):
    payload = json.dumps(event)
    with subs_lock:
        targets = list(subscribers)
    for q in targets:
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass


def pump_controllers():
    """Move controller events onto every open SSE stream."""
    while True:
        if hub is not None:
            for event in hub.drain():
                broadcast(event)
        time.sleep(0.005)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        pass                                  # quiet; this runs on a kiosk

    def end_headers(self):
        # Never let the browser cache the app itself.  A booth machine that
        # quietly serves yesterday's JavaScript is impossible to diagnose from
        # the outside - it looks like the code is broken rather than stale.
        # The vendored three.js is versioned and never changes, so it may cache.
        if not self.path.startswith("/vendor/"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------- GET
    def do_GET(self):
        if self.path.startswith("/api/events"):
            return self.stream_events()
        if self.path.startswith("/api/scores"):
            return self._json(load_scores())
        if self.path.startswith("/api/status"):
            status = hub.status() if hub else {"available": esp32link.HAVE_SERIAL,
                                                "connected": {}}
            status["enabled"] = hub is not None
            status["ports"] = esp32link.survey()
            return self._json(status)
        return super().do_GET()

    def stream_events(self):
        q = queue.Queue(maxsize=256)
        with subs_lock:
            subscribers.append(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    payload = q.get(timeout=10.0)
                    chunk = "data: %s\n\n" % payload
                except queue.Empty:
                    chunk = ": keepalive\n\n"   # keeps proxies and tabs awake
                self.wfile.write(chunk.encode("utf-8"))
                self.wfile.flush()
        except Exception:
            pass
        finally:
            with subs_lock:
                if q in subscribers:
                    subscribers.remove(q)

    # ------------------------------------------------------------- POST
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json({"error": "bad json"}, 400)

        if self.path.startswith("/api/scores"):
            mode = body.get("mode")
            entry = {
                "names": [str(n)[:16] for n in (body.get("names") or ["?"])][:2],
                "mode": mode if mode in ("solo", "versus", "coop") else "versus",
                "score": max(0, int(body.get("score") or 0)),
                "clicks": max(0, int(body.get("clicks") or 0)),
                "at": time.time(),
            }
            return self._json(add_score(entry))

        if self.path.startswith("/api/rescan"):
            if hub:
                hub.rescan()
            return self._json({"ok": True})

        if self.path.startswith("/api/feedback"):
            # let the game buzz/flash the boards on round start and finish
            if hub:
                line = str(body.get("line") or "")[:32]
                slot = body.get("player")
                if slot in (1, 2):
                    hub.send(int(slot), line)
                else:
                    hub.broadcast(line)
            return self._json({"ok": True})

        return self._json({"error": "unknown endpoint"}, 404)


def main(argv=None):
    global hub
    ap = argparse.ArgumentParser(description="Carnival Clicker server")
    ap.add_argument("--port", type=int, default=8770, help="http port")
    ap.add_argument("--serial", action="append", default=None,
                    help="force a controller port, repeatable (e.g. --serial COM5)")
    ap.add_argument("--players", type=int, default=2, choices=(1, 2))
    ap.add_argument("--probe-all", action="store_true",
                    help="open every serial port - will interrupt other paired devices")
    ap.add_argument("--no-serial", action="store_true", help="keyboard only")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--list-ports", action="store_true")
    args = ap.parse_args(argv)

    if args.list_ports:
        rows = esp32link.survey()
        if not rows:
            print("No serial ports found.")
        print("%-9s %-24s %-6s %s" % ("PORT", "PAIRED DEVICE", "", "WHY"))
        for r in rows:
            print("%-9s %-24s %-6s %s" % (r["port"][:9], (r["device"] or "-")[:24],
                                          "OPEN" if r["allowed"] else "skip",
                                          r["reason"]))
        return 0

    if not args.no_serial:
        if not esp32link.HAVE_SERIAL:
            print("pyserial missing - keyboard only.  pip install pyserial")
        else:
            hub = esp32link.ControllerHub(slots=args.players,
                                          probe_all=args.probe_all,
                                          forced=args.serial)
            hub.start()

    threading.Thread(target=pump_controllers, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    url = "http://127.0.0.1:%d/" % args.port
    print("Carnival Clicker serving on %s" % url)
    print("Controllers: %s" % ("off" if args.no_serial else "scanning..."))
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        if hub:
            hub.stop()
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())

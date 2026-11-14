#!/usr/bin/env python3
"""A pretend WVR for working on the manager without a device.
   python3 tools/mock.py   then open http://localhost:8032
Serves docs/ and answers the firmware's API; sounds are kept in memory and nothing plays."""
import http.server, json, pathlib, struct, sys, time, urllib.parse

WEB = pathlib.Path(__file__).resolve().parent.parent / "docs"
state = {"project": {"name": "New project", "master": 0, "slots": [], "pins": []}, "rev": 0, "files": {}, "playing": {},
         "device": {"name": "WVR-MOCK", "apPass": "12345678", "staSsid": "", "staPass": "", "oscPort": 8000, "midiChannel": 0}}

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)): body = json.dumps(body)
        if isinstance(body, str): body = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(body)
    def body(self): return self.rfile.read(int(self.headers.get("Content-Length", 0)))
    def handle_any(self):
        u = urllib.parse.urlparse(self.path); q = dict(urllib.parse.parse_qsl(u.query)); m = self.command; p = u.path
        now = time.time()
        state["playing"] = {s: t for s, t in state["playing"].items() if t > now}
        if not p.startswith("/api/"):
            f = WEB / ("index.html" if p == "/" else p.lstrip("/"))
            if not f.is_file(): return self.send(404, "not found", "text/plain")
            ctype = {".html": "text/html", ".css": "text/css", ".js": "text/javascript"}.get(f.suffix, "application/octet-stream")
            return self.send(200, f.read_bytes(), ctype)
        if p == "/api/state":
            return self.send(200, {"fw": "mock", "slots": 16, "voices": 8, "storage": True, "space": {"total": 7.8e9, "free": 7.8e9 - sum(map(len, state["files"].values()))},
                                   "ip": {"ap": "192.168.4.1", "sta": ""}, "device": state["device"],
                                   "files": [{"name": n, "size": len(b)} for n, b in state["files"].items()], "rev": state["rev"], "project": state["project"]})
        if p == "/api/status":
            on = sorted(state["playing"])
            return self.send(200, {"rev": state["rev"], "playing": on, "peak": [0.4, 0.3] if on else [0, 0], "voices": len(on), "under": 0, "master": 0, "heap": 100000, "errors": {}})
        if p == "/api/project" and m == "PUT":
            state["project"] = json.loads(self.body()); state["rev"] += 1
            return self.send(200, {"ok": True, "rev": state["rev"]})
        if p == "/api/device" and m == "PUT":
            state["device"].update(json.loads(self.body())); return self.send(200, {"ok": True})
        if p == "/api/file":
            name = q.get("name", "")
            if m == "PUT":
                b = self.body(); state["files"][name] = b
                ch, rate = struct.unpack_from("<HI", b, 22)
                return self.send(200, {"ok": True, "frames": (len(b) - 44) // (2 * ch), "rate": rate, "channels": ch})
            if m == "DELETE": state["files"].pop(name, None); return self.send(200, {"ok": True})
            if name in state["files"]: return self.send(200, state["files"][name], "audio/wav")
            return self.send(404, {"ok": False, "error": "no such file"})
        if p == "/api/play":
            slot = int(q.get("slot", 0)); s = (state["project"].get("slots") or [])
            dur = s[slot - 1].get("dur", 1) if 0 < slot <= len(s) else 1
            state["playing"][slot] = now + (3600 if 0 < slot <= len(s) and s[slot - 1].get("loop") else dur)
            return self.send(200, {"ok": True})
        if p == "/api/stop":
            slot = int(q.get("slot", 0))
            if slot: state["playing"].pop(slot, None)
            else: state["playing"].clear()
            return self.send(200, {"ok": True})
        return self.send(200, {"ok": True})
    do_GET = do_PUT = do_POST = do_DELETE = handle_any
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS"); self.end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8032
print(f"Pretend WVR at http://localhost:{port}")
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()

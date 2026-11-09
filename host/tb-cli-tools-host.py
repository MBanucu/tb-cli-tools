#!/usr/bin/env python3
"""Native-messaging-Host fuer tb-cli-tools.

Startet Thunderbird selbst. Nimmt Auftraege ueber einen Unix-Socket vom CLI
entgegen, reicht sie an die Erweiterung weiter und liefert deren Ergebnis
zurueck. Anhaenge werden waehrend des Auftrags kurzzeitig ueber HTTP
(127.0.0.1) bereitgestellt.
"""
import http.server
import json
import mimetypes
import os
import socket
import struct
import sys
import threading
import time
import urllib.parse
import uuid

SOCK_PATH = os.environ.get("TB_CLI_TOOLS_SOCK") or os.path.join(
    os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "tb-cli-tools.sock"
)
HTTP_PORT = int(os.environ.get("TB_CLI_TOOLS_HTTP_PORT", "8767"))
MAX_WAIT = 300

write_lock = threading.Lock()
files = {}
results = {}
results_cond = threading.Condition()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def write_message(obj):
    data = json.dumps(obj).encode("utf-8")
    with write_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    data = sys.stdin.buffer.read(n)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


class FileHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        parts = urllib.parse.urlparse(self.path).path.strip("/").split("/")
        if len(parts) != 3 or parts[0] != "f":
            self.send_response(404)
            self.end_headers()
            return
        token, name = parts[1], urllib.parse.unquote(parts[2])
        path = files.get(token, {}).get(name)
        if not path or not os.path.isfile(path):
            self.send_response(404)
            self.end_headers()
            return
        with open(path, "rb") as fh:
            data = fh.read()
        # Echten Typ liefern, damit die Erweiterung Anhaenge mit
        # text/plain bzw. image/jpeg statt application/octet-stream anhaengt.
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def handle_client(conn):
    try:
        with conn, conn.makefile("rwb") as stream:
            line = stream.readline()
            if not line:
                return
            job = json.loads(line.decode("utf-8"))
            job_id = uuid.uuid4().hex

            if job.get("attachments"):
                token = uuid.uuid4().hex
                names = {}
                for path in job["attachments"]:
                    names[os.path.basename(path)] = path
                files[token] = names
                job["attachmentUrls"] = [
                    {
                        "name": name,
                        "url": "http://127.0.0.1:%d/f/%s/%s"
                        % (HTTP_PORT, token, urllib.parse.quote(name)),
                    }
                    for name in names
                ]

            write_message({"type": "job", "id": job_id, "job": job})
            log("Auftrag %s an Erweiterung gegeben" % job_id[:8])

            with results_cond:
                deadline = time.time() + MAX_WAIT
                while job_id not in results and time.time() < deadline:
                    results_cond.wait(timeout=1)
                res = results.pop(job_id, {"ok": False, "error": "Zeitueberschreitung im Host"})
            stream.write((json.dumps(res) + "\n").encode("utf-8"))
            stream.flush()
    except Exception as exc:  # CLI soll eine Antwort bekommen, kein haengender Socket
        log("Fehler beim Auftrag: %r" % (exc,))


def serve_socket():
    try:
        os.unlink(SOCK_PATH)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK_PATH)
    os.chmod(SOCK_PATH, 0o600)
    srv.listen(8)
    log("Socket bereit: %s" % SOCK_PATH)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle_client, args=(conn,), daemon=True).start()


def main():
    threading.Thread(target=serve_socket, daemon=True).start()
    http_srv = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), FileHandler)
    threading.Thread(target=http_srv.serve_forever, daemon=True).start()
    log("Host gestartet (HTTP 127.0.0.1:%d)" % HTTP_PORT)
    while True:
        msg = read_message()
        if msg is None:
            break
        if msg.get("type") == "result":
            with results_cond:
                results[msg.get("id")] = msg
                results_cond.notify_all()
    log("Host beendet")
    try:
        os.unlink(SOCK_PATH)
    except OSError:
        pass


if __name__ == "__main__":
    main()

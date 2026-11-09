#!/usr/bin/env python3
"""Tests fuer den Native-Messaging-Host (tb-cli-tools-host.py).

Deckt genau die Faelle ab, die den Host frueher in eine Neustart-Schleife
gebracht haben: ein belegter HTTP-Port, eine zweite Host-Instanz und ein toter
Socket-Rest im Runtime-Verzeichnis. Laeuft ohne Thunderbird:

    python3 tests/host_test.py
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HOST = Path(__file__).resolve().parent.parent / "host" / "tb-cli-tools-host.py"
SOCK_NAME = "tb-cli-tools.sock"


def free_port():
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


class HostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.procs = []

    def tearDown(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream:
                    stream.close()
        self.tmp.cleanup()

    @property
    def sock_path(self):
        return str(self.dir / SOCK_NAME)

    def start(self, port):
        proc = subprocess.Popen(
            [sys.executable, str(HOST)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={
                "XDG_RUNTIME_DIR": str(self.dir),
                "TB_CLI_TOOLS_HTTP_PORT": str(port),
                "PATH": os.environ.get("PATH", ""),
            },
        )
        self.procs.append(proc)
        return proc

    def die_reason(self, proc):
        try:
            err = proc.stderr.read().decode("utf-8", "replace")
        except Exception:
            err = ""
        return "Host vorzeitig beendet (rc=%s): %s" % (proc.returncode, err.strip())

    def wait_listening(self, proc, timeout=10.0):
        """Wartet, bis der Unix-Socket erreichbar ist (nicht nur die Datei da ist)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                self.fail(self.die_reason(proc))
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                    probe.settimeout(0.5)
                    probe.connect(self.sock_path)
                    return
            except OSError:
                time.sleep(0.05)
        self.fail("Socket %s wird nicht bedient" % self.sock_path)

    def connect(self):
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(5)
        conn.connect(self.sock_path)
        return conn

    def test_host_starts_and_serves_socket(self):
        proc = self.start(free_port())
        self.wait_listening(proc)
        self.assertIsNone(proc.poll())

    def test_busy_http_port_does_not_kill_host(self):
        port = free_port()
        blocker = socket.socket()
        blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        blocker.bind(("127.0.0.1", port))
        blocker.listen(1)
        try:
            proc = self.start(port)
            self.wait_listening(proc)
            self.assertIsNone(proc.poll(), "Host stirbt an einem belegten HTTP-Port")

            # Ein Auftrag mit Anhang muss mit Fehler antworten statt den Host zu beenden.
            with self.connect() as conn:
                conn.sendall(
                    (
                        json.dumps(
                            {
                                "action": "print",
                                "emlPath": "/tmp/nicht-vorhanden.eml",
                                "outPath": "/tmp/nicht-vorhanden.pdf",
                                "attachments": ["/etc/hostname"],
                            }
                        )
                        + "\n"
                    ).encode("utf-8")
                )
                reply = json.loads(conn.makefile("rb").readline().decode("utf-8"))

            self.assertFalse(reply.get("ok"))
            self.assertIn("HTTP port", reply.get("error", ""))
            self.assertIn("already in use", reply.get("error", ""))
            time.sleep(0.3)
            self.assertIsNone(proc.poll(), "Host ist nach dem Anhang-Auftrag beendet")
            self.wait_listening(proc)
        finally:
            blocker.close()

    def test_second_instance_exits_without_breaking_first(self):
        port = free_port()
        first = self.start(port)
        self.wait_listening(first)

        second = self.start(port)
        try:
            second.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.fail("zweite Host-Instanz laeuft weiter statt sich zu beenden")
        self.assertEqual(second.returncode, 0, self.die_reason(second))

        self.assertIsNone(first.poll(), "erste Instanz wurde von der zweiten beendet")
        self.wait_listening(first)

    def test_stale_socket_file_is_replaced(self):
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(self.sock_path)
        stale.listen(1)
        stale.close()  # Datei bleibt liegen, es lauscht niemand mehr

        proc = self.start(free_port())
        self.wait_listening(proc)
        self.assertIsNone(proc.poll())


if __name__ == "__main__":
    unittest.main(verbosity=2)

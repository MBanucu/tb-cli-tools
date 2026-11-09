#!/usr/bin/env python3
"""Legt per CLI eine neue Nachricht im Verfassen-Fenster an (ohne zu senden).

Beispiel:
  ./tb-compose.py --to artur.kuhn@jobcenter-ge.de \
                  --subject 'Kundennummer: 000D343391 - Bearbeitungsstand des Antrags' \
                  --body-file antwort.txt
"""
import argparse
import json
import os
import socket
import sys


def socket_path():
    return os.environ.get("TB_CLI_TOOLS_SOCK") or os.path.join(
        os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "tb-cli-tools.sock"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--to", action="append", required=True, help="Empfaenger (mehrfach moeglich)")
    ap.add_argument("--cc", action="append", default=[], help="Cc (mehrfach moeglich)")
    ap.add_argument("--bcc", action="append", default=[], help="Bcc (mehrfach moeglich)")
    ap.add_argument("--subject", required=True, help="Betreff")
    ap.add_argument("--body-file", required=True, help="Textdatei mit dem Nachrichtentext")
    ap.add_argument("--attach", action="append", default=[], help="Datei anhaengen (mehrfach moeglich)")
    ap.add_argument("--html", dest="plain_text", action="store_false", default=None,
                    help="Nachricht als HTML erzwingen (Standard: Format der Identity)")
    ap.add_argument("--text", dest="plain_text", action="store_true",
                    help="Nachricht als reinen Text erzwingen")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--socket", default=socket_path())
    args = ap.parse_args()

    with open(args.body_file, encoding="utf-8", newline="") as fh:
        body = fh.read()
    job = {
        "action": "compose",
        "to": args.to,
        "cc": args.cc,
        "bcc": args.bcc,
        "subject": args.subject,
        "body": body,
        "plainText": args.plain_text,
        "attachments": [os.path.abspath(p) for p in args.attach],
    }

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(args.timeout)
    try:
        sock.connect(args.socket)
    except (FileNotFoundError, ConnectionRefusedError):
        print("Kein Host erreichbar (%s). Laeuft Thunderbird mit aktivem Add-on?" % args.socket,
              file=sys.stderr)
        return 3
    try:
        with sock, sock.makefile("rwb") as stream:
            stream.write((json.dumps(job) + "\n").encode("utf-8"))
            stream.flush()
            line = stream.readline()
    except socket.timeout:
        print("Zeitueberschreitung: keine Antwort vom Add-on.", file=sys.stderr)
        return 2
    if not line:
        print("Verbindung ohne Antwort geschlossen.", file=sys.stderr)
        return 2
    result = json.loads(line.decode("utf-8"))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())

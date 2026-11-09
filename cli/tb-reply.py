#!/usr/bin/env python3
"""Erzeugt per CLI eine echte Antwort (mit Thunderbird-Zitat und Threading).

Beispiel:
  ./tb-reply.py --message-id '<WGE77EVW323_...@zendesk.com>' \
                --body-file ../../Antworten/body.txt \
                --attach ../../Antworten/Anhaenge/evidence.txt
"""
import argparse
import json
import os
import socket
import sys


def socket_path():
    return os.environ.get("TB_CLI_REPLY_SOCK") or os.path.join(
        os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "tb-cli-reply.sock"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--message-id", required=True, help="Message-ID der zu beantwortenden Mail")
    ap.add_argument("--body-file", required=True, help="Textdatei mit dem Antworttext")
    ap.add_argument("--attach", action="append", default=[], help="Datei anhaengen (mehrfach moeglich)")
    ap.add_argument("--all", action="store_true", help="Allen antworten statt nur dem Absender")
    ap.add_argument("--html", dest="plain_text", action="store_false", default=None,
                    help="Antwort als HTML erzwingen (Standard: Format der Identity)")
    ap.add_argument("--text", dest="plain_text", action="store_true",
                    help="Antwort als reinen Text erzwingen")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--socket", default=socket_path())
    args = ap.parse_args()

    with open(args.body_file, encoding="utf-8", newline="") as fh:
        body = fh.read()
    job = {
        "headerMessageId": args.message_id,
        "body": body,
        "plainText": args.plain_text,
        "all": bool(args.all),
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

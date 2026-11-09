#!/usr/bin/env python3
"""Print an .eml to PDF through Thunderbird's own print engine.

Example:
  ./tb-print.py --eml "../../02_Kamera_Bug/Email_....eml" --out /tmp/x.pdf
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
    ap.add_argument("--eml", required=True, help="Path to the .eml file")
    ap.add_argument("--out", required=True, help="Target PDF")
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--socket", default=socket_path())
    args = ap.parse_args()

    job = {
        "action": "print",
        "emlPath": os.path.abspath(args.eml),
        "outPath": os.path.abspath(args.out),
    }

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(args.timeout)
    try:
        sock.connect(args.socket)
    except (FileNotFoundError, ConnectionRefusedError):
        print("No host reachable (%s)." % args.socket, file=sys.stderr)
        return 3
    try:
        with sock, sock.makefile("rwb") as stream:
            stream.write((json.dumps(job) + "\n").encode("utf-8"))
            stream.flush()
            line = stream.readline()
    except socket.timeout:
        print("Timeout: no answer from the add-on.", file=sys.stderr)
        return 2
    if not line:
        print("Connection closed without an answer.", file=sys.stderr)
        return 2
    result = json.loads(line.decode("utf-8"))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())

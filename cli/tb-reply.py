#!/usr/bin/env python3
"""Create a real reply from the command line (with Thunderbird's quote and threading).

Example:
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
    return os.environ.get("TB_CLI_TOOLS_SOCK") or os.path.join(
        os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "tb-cli-tools.sock"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--message-id", required=True, help="Message-ID of the mail to reply to")
    ap.add_argument("--body-file", required=True, help="Text file holding the reply body")
    ap.add_argument("--attach", action="append", default=[], help="Attach a file (may be repeated)")
    ap.add_argument("--all", action="store_true", help="Reply to all recipients instead of the sender only")
    ap.add_argument("--html", dest="plain_text", action="store_false", default=None,
                    help="Force an HTML reply (default: the identity's format)")
    ap.add_argument("--text", dest="plain_text", action="store_true",
                    help="Force a plain-text reply")
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
        print("No host reachable (%s). Is Thunderbird running with the add-on enabled?" % args.socket,
              file=sys.stderr)
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
